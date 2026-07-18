import * as p from "@clack/prompts";
import type {
  AppConfig,
  AppEnvironment,
  CloudflareConfig,
  DeploykitConfig,
  EnvironmentKind,
} from "./config.js";
import type { DetectedApp, Detection } from "./detect.js";
import { listCloudflareZones } from "./cloudflare.js";
import { listFlyOrgs } from "./fly.js";
import { readCredential, saveCredential } from "./secrets-file.js";
import { pc } from "./util/log.js";

/** Custom hostnames keyed by app name → environment. */
type HostMap = Record<string, Partial<Record<EnvironmentKind, string>>>;

export interface InitOptions {
  yes: boolean;
  org?: string;
  region?: string;
  dryRun: boolean;
  provision: boolean;
  pr: boolean;
  /** Overwrite files that already exist instead of skipping them. */
  force: boolean;
  cwd: string;
}

const COMMON_REGIONS = [
  { value: "iad", label: "iad — Ashburn, Virginia (US)" },
  { value: "sjc", label: "sjc — San Jose, California (US)" },
  { value: "ord", label: "ord — Chicago, Illinois (US)" },
  { value: "lhr", label: "lhr — London (UK)" },
  { value: "fra", label: "fra — Frankfurt (DE)" },
  { value: "ams", label: "ams — Amsterdam (NL)" },
  { value: "syd", label: "syd — Sydney (AU)" },
  { value: "nrt", label: "nrt — Tokyo (JP)" },
];

const ENV_OPTIONS: { value: EnvironmentKind; label: string; hint: string }[] = [
  { value: "preview", label: "PR previews", hint: "one app per pull request, auto torn down" },
  { value: "staging", label: "Staging", hint: "deploys on merge to main" },
  { value: "production", label: "Production", hint: "manual approval gate" },
];

const ALL_ENVS: EnvironmentKind[] = ["preview", "staging", "production"];

/**
 * Phase 2 — turn a Detection into a finished config. Interactive by default;
 * with `--yes` it accepts detected defaults and reads org/region from flags.
 * Returns null if the user cancels.
 */
export async function buildConfig({
  detection,
  opts,
  flyReady = false,
}: {
  detection: Detection;
  opts: InitOptions;
  /** Whether flyctl is authenticated — enables the org picker. */
  flyReady?: boolean;
}) {
  const deployable = detection.apps.filter((a) => a.deployable);

  if (opts.yes) return buildFromDefaults({ detection, deployable, opts });

  const chosenApps = await pickApps(deployable);
  if (!chosenApps) return cancel();

  const envs = await pickEnvironments();
  if (!envs) return cancel();

  const provider = await pickProvider(opts, flyReady);
  if (!provider) return cancel();

  const cf = await pickCloudflare({ apps: chosenApps, envs, cwd: opts.cwd });
  if (!cf) return cancel();

  noteSecrets(chosenApps);

  return assemble({
    detection,
    apps: chosenApps,
    envs,
    provider,
    cloudflare: cf.cloudflare,
    hostnames: cf.hostnames,
  });
}

function buildFromDefaults({
  detection,
  deployable,
  opts,
}: {
  detection: Detection;
  deployable: DetectedApp[];
  opts: InitOptions;
}) {
  const org = opts.org ?? process.env.FLY_ORG;
  if (!org) {
    p.log.error(
      "Non-interactive mode needs a Fly org: pass --org <slug> or set FLY_ORG.",
    );
    return null;
  }
  return assemble({
    detection,
    apps: deployable,
    envs: ALL_ENVS,
    provider: { org, region: opts.region ?? "iad" },
  });
}

async function pickApps(deployable: DetectedApp[]) {
  const choice = await p.multiselect({
    message: "Which apps should deploykit deploy?",
    options: deployable.map((a) => ({
      value: a.name,
      label: `${a.name} ${pc.dim(`(${a.framework} · ${a.serve}, port ${a.port})`)}`,
      hint: a.root,
    })),
    initialValues: deployable.map((a) => a.name),
    required: true,
  });
  if (p.isCancel(choice)) return null;
  return deployable.filter((a) => choice.includes(a.name));
}

async function pickEnvironments() {
  // No pre-selection: the chosen set is exactly what the user checks, so
  // highlighting "Staging" and hitting enter yields staging only.
  const choice = await p.multiselect({
    message: "Which environments? (space to toggle, enter to confirm)",
    options: ENV_OPTIONS,
    required: true,
  });
  // ENV_OPTIONS values are all EnvironmentKind; clack widens to unknown[] here
  // because there's no initialValues to infer from.
  return p.isCancel(choice) ? null : (choice as EnvironmentKind[]);
}

const MANUAL_ORG = "__manual__";

async function pickProvider(opts: InitOptions, flyReady: boolean) {
  const org = await pickOrg(opts, flyReady);
  if (org === null) return null;

  const region = await p.select({
    message: "Default Fly region",
    options: COMMON_REGIONS,
    initialValue: opts.region ?? "iad",
  });
  if (p.isCancel(region)) return null;

  return { org, region };
}

/**
 * Pick a Fly org. When flyctl is authenticated we list the orgs on the account
 * so the user can select instead of remembering slugs; otherwise (or if the
 * user picks "enter manually") we fall back to a free-text slug.
 */
async function pickOrg(opts: InitOptions, flyReady: boolean): Promise<string | null> {
  const orgs = flyReady ? await listFlyOrgs(opts.cwd) : null;
  if (!orgs) return typeOrg(opts);

  const sel = await p.select({
    message: "Fly organization",
    options: [
      ...orgs.map((o) => ({
        value: o.slug,
        label: o.name && o.name !== o.slug ? `${o.slug} ${pc.dim(`— ${o.name}`)}` : o.slug,
      })),
      { value: MANUAL_ORG, label: pc.dim("Enter a slug manually…") },
    ],
    initialValue: opts.org && orgs.some((o) => o.slug === opts.org) ? opts.org : orgs[0]?.slug,
  });
  if (p.isCancel(sel)) return null;
  return sel === MANUAL_ORG ? typeOrg(opts) : sel;
}

async function typeOrg(opts: InitOptions): Promise<string | null> {
  const org = await p.text({
    message: "Fly organization slug",
    placeholder: opts.org ?? "personal",
    initialValue: opts.org ?? "",
    validate: (v) => (v.trim() ? undefined : "Required"),
  });
  return p.isCancel(org) ? null : org.trim();
}

const MANUAL_ZONE = "__manual_zone__";

/**
 * Ask whether to wire custom domains through Cloudflare, and if so resolve a
 * token, pick the zone, and collect a hostname per staging/production
 * environment. Returns `{ hostnames }` with no `cloudflare` when the user
 * declines, or null on cancel.
 */
async function pickCloudflare({
  apps,
  envs,
  cwd,
}: {
  apps: DetectedApp[];
  envs: EnvironmentKind[];
  cwd: string;
}): Promise<{ cloudflare?: CloudflareConfig; hostnames: HostMap } | null> {
  // Only staging/production get custom domains — previews stay on *.fly.dev.
  const domainKinds = (["staging", "production"] as const).filter((k) => envs.includes(k));
  if (domainKinds.length === 0) return { hostnames: {} };

  const enable = await p.confirm({
    message: "Wire up custom domains through Cloudflare?",
    initialValue: false,
  });
  if (p.isCancel(enable)) return null;
  if (!enable) return { hostnames: {} };

  const token = await resolveCloudflareToken(cwd);
  if (token === null) return null; // cancelled
  if (!token) {
    p.log.warn(
      "No Cloudflare token — recording the domains in the config; provisioning is skipped until CLOUDFLARE_API_TOKEN is set.",
    );
  }

  const zone = await pickZone(token);
  if (zone === null) return null;

  const hostnames: HostMap = {};
  for (const app of apps) {
    for (const kind of domainKinds) {
      const suggestion = kind === "production" ? zone : `${kind}.${zone}`;
      const host = await p.text({
        message: `${pc.bold(app.name)} · ${kind} hostname ${pc.dim("(blank to skip)")}`,
        placeholder: suggestion,
        initialValue: suggestion,
      });
      if (p.isCancel(host)) return null;
      const h = host.trim();
      if (h) (hostnames[app.name] ??= {})[kind] = h;
    }
  }

  const cloudflare: CloudflareConfig = {
    zone,
    proxied: true,
    ssl: "strict",
    alwaysUseHttps: true,
    minTlsVersion: "1.2",
    security: true,
    cache: true,
  };
  return { cloudflare, hostnames };
}

/**
 * Resolve a Cloudflare API token: env var → saved credentials file → masked
 * prompt (offering to save it for next time). Returns the token, "" when the
 * user opts to skip provisioning, or null on cancel. When found via file or
 * prompt it's exported to the process so the provisioning step picks it up.
 */
async function resolveCloudflareToken(cwd: string): Promise<string | null> {
  const fromEnv = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const fromFile = readCredential(cwd, "CLOUDFLARE_API_TOKEN");
  if (fromFile) {
    process.env.CLOUDFLARE_API_TOKEN = fromFile;
    p.log.info("Using the Cloudflare token saved in .deploykit/credentials.");
    return fromFile;
  }

  const pasted = await p.password({
    message: "Cloudflare API token (blank to skip provisioning now)",
  });
  if (p.isCancel(pasted)) return null;
  const token = pasted.trim();
  if (!token) return "";

  process.env.CLOUDFLARE_API_TOKEN = token;
  const save = await p.confirm({
    message: "Save this token to .deploykit/credentials (gitignored) for next time?",
    initialValue: true,
  });
  if (!p.isCancel(save) && save) {
    const res = saveCredential(cwd, "CLOUDFLARE_API_TOKEN", token);
    p.log.success(pc.green(`Saved token → ${res.path}`));
    if (!res.gitignored)
      p.log.warn(`Add ${res.path} to .gitignore — couldn't do it automatically.`);
  }
  return token;
}

/**
 * Pick the Cloudflare zone. With a token we list the account's zones for a
 * select (mirrors the Fly org picker); otherwise fall back to typing.
 */
async function pickZone(token: string): Promise<string | null> {
  const zones = token ? await listCloudflareZones({ token }) : null;
  if (!zones || zones.length === 0) return typeZone();

  const sel = await p.select({
    message: "Cloudflare zone (root domain)",
    options: [
      ...zones.map((z) => ({ value: z.name, label: z.name })),
      { value: MANUAL_ZONE, label: pc.dim("Enter a domain manually…") },
    ],
    initialValue: zones[0]?.name,
  });
  if (p.isCancel(sel)) return null;
  return sel === MANUAL_ZONE ? typeZone() : sel;
}

async function typeZone(): Promise<string | null> {
  const zoneInput = await p.text({
    message: "Cloudflare zone (root domain)",
    placeholder: "example.com",
    validate: (v) => (v.trim() ? undefined : "Required"),
  });
  return p.isCancel(zoneInput) ? null : zoneInput.trim();
}

/** Surface detected secret names so the user knows what they'll need to set. */
function noteSecrets(apps: DetectedApp[]) {
  const withSecrets = apps.filter((a) => a.secrets.length);
  if (!withSecrets.length) return;
  p.note(
    withSecrets
      .map((a) => `${pc.bold(a.name)}: ${a.secrets.join(", ")}`)
      .join("\n"),
    "Detected env vars (names only — set these as GitHub secrets)",
  );
}

function assemble({
  detection,
  apps,
  envs,
  provider,
  cloudflare,
  hostnames,
}: {
  detection: Detection;
  apps: DetectedApp[];
  envs: EnvironmentKind[];
  provider: { org: string; region: string };
  cloudflare?: CloudflareConfig;
  hostnames?: HostMap;
}) {
  const appMap: Record<string, AppConfig> = {};
  for (const a of apps)
    appMap[a.name] = appConfigFor({ app: a, envs, hosts: hostnames?.[a.name] });

  const config: DeploykitConfig = {
    tool: detection.tool,
    packageManager: detection.packageManager,
    nodeVersion: detection.nodeVersion,
    provider: { type: "fly", org: provider.org, region: provider.region },
    apps: appMap,
  };
  if (cloudflare) config.cloudflare = cloudflare;
  if (detection.installEnv) config.installEnv = detection.installEnv;
  if (detection.nxIntegrated !== undefined) config.nxIntegrated = detection.nxIntegrated;
  return config;
}

function appConfigFor({
  app,
  envs,
  hosts,
}: {
  app: DetectedApp;
  envs: EnvironmentKind[];
  hosts?: Partial<Record<EnvironmentKind, string>>;
}) {
  const environments: Partial<Record<EnvironmentKind, AppEnvironment>> = {};
  if (envs.includes("preview"))
    environments.preview = { name: `${app.name}-pr-{pr}`, trigger: "pr" };
  if (envs.includes("staging"))
    environments.staging = withHost({ name: `${app.name}-staging`, trigger: "push:main" }, hosts?.staging);
  if (envs.includes("production"))
    environments.production = withHost({ name: `${app.name}-prod`, trigger: "manual" }, hosts?.production);

  const config: AppConfig = {
    root: app.root,
    packageName: app.packageName,
    framework: app.framework,
    serve: app.serve,
    port: app.port,
    internalDeps: app.internalDeps,
    watchPaths: app.watchPaths,
    environments,
    secrets: app.secrets,
  };
  // Only persist the runner-shaping fields when they carry information, so the
  // generated config stays minimal for the common case.
  if (app.startCommand) config.startCommand = app.startCommand;
  if (app.outputDir) config.outputDir = app.outputDir;
  if (app.spa) config.spa = true;
  if (app.prisma?.length) config.prisma = app.prisma;
  return config;
}

const withHost = (env: AppEnvironment, hostname?: string): AppEnvironment =>
  hostname ? { ...env, hostname } : env;

function cancel() {
  p.cancel("Cancelled.");
  return null;
}
