import * as p from "@clack/prompts";
import type {
  AppConfig,
  AppEnvironment,
  DeploykitConfig,
  EnvironmentKind,
} from "./config.js";
import type { DetectedApp, Detection } from "./detect.js";
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
}: {
  detection: Detection;
  opts: InitOptions;
}) {
  const deployable = detection.apps.filter((a) => a.deployable);

  if (opts.yes) return buildFromDefaults({ detection, deployable, opts });

  const chosenApps = await pickApps(deployable);
  if (!chosenApps) return cancel();

  const envs = await pickEnvironments();
  if (!envs) return cancel();

  const provider = await pickProvider(opts);
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
  const choice = await p.multiselect({
    message: "Which environments?",
    options: ENV_OPTIONS,
    initialValues: ALL_ENVS,
    required: true,
  });
  return p.isCancel(choice) ? null : choice;
}

async function pickProvider(opts: InitOptions) {
  const org = await p.text({
    message: "Fly organization slug",
    placeholder: opts.org ?? "personal",
    initialValue: opts.org ?? "",
    validate: (v) => (v.trim() ? undefined : "Required"),
  });
  if (p.isCancel(org)) return null;

  const region = await p.select({
    message: "Default Fly region",
    options: COMMON_REGIONS,
    initialValue: opts.region ?? "iad",
  });
  if (p.isCancel(region)) return null;

  return { org: org.trim(), region };
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
