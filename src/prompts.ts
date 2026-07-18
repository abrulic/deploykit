import * as p from "@clack/prompts";
import type {
  AppConfig,
  AppEnvironment,
  DeploykitConfig,
  EnvironmentKind,
} from "./config.js";
import type { DetectedApp, Detection } from "./detect.js";
import { listFlyOrgs } from "./fly.js";
import { pc } from "./util/log.js";

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

  noteSecrets(chosenApps);

  return assemble({ detection, apps: chosenApps, envs, provider });
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
      label: `${a.name} ${pc.dim(`(${a.framework}, port ${a.port})`)}`,
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
}: {
  detection: Detection;
  apps: DetectedApp[];
  envs: EnvironmentKind[];
  provider: { org: string; region: string };
}) {
  const appMap: Record<string, AppConfig> = {};
  for (const a of apps) appMap[a.name] = appConfigFor({ app: a, envs });

  return {
    tool: detection.tool,
    packageManager: detection.packageManager,
    nodeVersion: detection.nodeVersion,
    provider: { type: "fly", org: provider.org, region: provider.region },
    apps: appMap,
  } satisfies DeploykitConfig;
}

function appConfigFor({ app, envs }: { app: DetectedApp; envs: EnvironmentKind[] }) {
  const environments: Partial<Record<EnvironmentKind, AppEnvironment>> = {};
  if (envs.includes("preview"))
    environments.preview = { name: `${app.name}-pr-{pr}`, trigger: "pr" };
  if (envs.includes("staging"))
    environments.staging = { name: `${app.name}-staging`, trigger: "push:main" };
  if (envs.includes("production"))
    environments.production = { name: `${app.name}-prod`, trigger: "manual" };

  return {
    root: app.root,
    packageName: app.packageName,
    framework: app.framework,
    port: app.port,
    internalDeps: app.internalDeps,
    watchPaths: app.watchPaths,
    environments,
    secrets: app.secrets,
  } satisfies AppConfig;
}

function cancel() {
  p.cancel("Cancelled.");
  return null;
}
