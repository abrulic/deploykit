import * as p from "@clack/prompts";
import type { DeploykitConfig, EnvironmentKind } from "../config.js";
import { loadConfigFile } from "../config-file.js";
import type { InitOptions } from "../prompts.js";
import { execInteractive, tryExec } from "../util/exec.js";
import { pc } from "../util/log.js";

/** Environments with a concrete (non-placeholder) Fly app name we can redeploy. */
const ROLLBACKABLE: readonly EnvironmentKind[] = ["staging", "production"];

/** A past Fly release, normalized from `flyctl releases --json`. */
export interface Release {
  version: number;
  status: string;
  description: string;
  /** Docker image reference to redeploy, e.g. registry.fly.io/app@sha256:… */
  image: string;
  createdAt: string;
  stable: boolean;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Parse `flyctl releases --json` defensively. flyctl's key casing has varied
 * across versions (ImageRef / imageRef / image_ref), so keys are normalized to
 * lowercase-without-underscores before lookup. Anything unparseable is dropped
 * rather than guessed at.
 */
export function parseReleases(json: string): Release[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const releases: Release[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const norm: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item))
      norm[k.toLowerCase().replace(/_/g, "")] = v;

    const version = Number(norm.version);
    if (!Number.isFinite(version)) continue;

    releases.push({
      version,
      status: str(norm.status),
      description: str(norm.description),
      image: str(norm.imageref) || str(norm.image) || str(norm.dockerimage),
      createdAt: str(norm.createdat) || str(norm.timestamp),
      stable: Boolean(norm.stable),
    });
  }
  return releases;
}

/**
 * Prior releases we can roll back to: those carrying a redeployable image,
 * excluding the current (highest-version) release, newest first.
 */
export function rollbackCandidates(releases: Release[]): Release[] {
  if (releases.length === 0) return [];
  const current = Math.max(...releases.map((r) => r.version));
  return releases
    .filter((r) => r.image !== "" && r.version < current)
    .sort((a, b) => b.version - a.version);
}

/**
 * The `flyctl deploy` argv that redeploys a prior image — no rebuild. The repo's
 * fly.toml is applied so the app runs with its committed service config, and the
 * environment's concrete Fly app is targeted with `--app`.
 */
export function rollbackDeployArgs({
  flyApp,
  root,
  image,
}: {
  flyApp: string;
  root: string;
  image: string;
}): string[] {
  return [
    "deploy",
    "--app",
    flyApp,
    "--image",
    image,
    "--config",
    `${root}/fly.toml`,
  ];
}

/** Injected IO seams, so the orchestration is testable without a real Fly. */
export interface RollbackDeps {
  /** Raw stdout of `flyctl releases --app <flyApp> --json`, or null on failure. */
  listReleases: (flyApp: string, cwd: string) => Promise<string | null>;
  runDeploy: (args: string[], cwd: string) => Promise<number>;
  select: (
    message: string,
    options: { value: string; label: string }[],
  ) => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  log: {
    info: (s: string) => void;
    warn: (s: string) => void;
    success: (s: string) => void;
    error: (s: string) => void;
    step: (s: string) => void;
  };
}

const defaultDeps: RollbackDeps = {
  listReleases: (flyApp, cwd) =>
    tryExec({
      cmd: "flyctl",
      args: ["releases", "--app", flyApp, "--json"],
      cwd,
    }),
  runDeploy: (args, cwd) => execInteractive({ cmd: "flyctl", args, cwd }),
  select: async (message, options) => {
    const r = await p.select({ message, options });
    return typeof r === "string" ? r : null;
  },
  confirm: async (message) =>
    (await p.confirm({ message, initialValue: false })) === true,
  log: {
    info: (s) => p.log.info(s),
    warn: (s) => p.log.warn(s),
    success: (s) => p.log.success(pc.green(s)),
    error: (s) => p.log.error(s),
    step: (s) => p.log.step(s),
  },
};

/**
 * `deploykit rollback` — redeploy a prior image for one environment's Fly app.
 *
 * This rolls back the APP only. It does not undo database migrations: if the
 * release you are leaving ran a forward migration, redeploying an older image
 * against the migrated schema can break — so the target and the exact command
 * are shown and confirmed before anything runs.
 */
export async function runRollback(
  opts: InitOptions,
  depsOverride?: Partial<RollbackDeps>,
) {
  const deps = { ...defaultDeps, ...depsOverride };
  p.intro(pc.bgCyan(pc.black(" deploykit rollback ")));

  const loaded = loadConfigFile(opts.cwd);
  if (loaded.error !== undefined) {
    deps.log.error(loaded.error);
    p.outro(pc.red("Rollback failed."));
    return 1;
  }
  const config = loaded.config;

  const target = await resolveTarget({ config, opts, deps });
  if ("error" in target) {
    deps.log.error(target.error);
    p.outro(pc.red("Rollback failed."));
    return 1;
  }
  const { appName, env, flyApp, root } = target;
  deps.log.step(
    `Rolling back ${pc.bold(appName)} · ${pc.bold(env)} → Fly app ${pc.bold(flyApp)}`,
  );

  const raw = await deps.listReleases(flyApp, opts.cwd);
  if (raw === null) {
    deps.log.error(
      `Couldn't list releases for ${flyApp} (is flyctl authenticated and the app provisioned?).`,
    );
    p.outro(pc.red("Rollback failed."));
    return 1;
  }
  const candidates = rollbackCandidates(parseReleases(raw));
  if (candidates.length === 0) {
    deps.log.error(
      "No prior release with a redeployable image was found — nothing to roll back to.",
    );
    p.outro(pc.red("Rollback failed."));
    return 1;
  }

  const chosen = await chooseRelease({ candidates, opts, deps });
  if (!chosen) {
    p.outro(pc.dim("Rollback cancelled."));
    return 1;
  }

  const args = rollbackDeployArgs({ flyApp, root, image: chosen.image });
  deps.log.warn(
    "This redeploys the app image only. It does NOT undo database migrations — " +
      "if a newer release migrated the schema, an older image may not run against it.",
  );
  deps.log.info(`Will run: ${pc.dim(`flyctl ${args.join(" ")}`)}`);

  if (
    !opts.yes &&
    !(await deps.confirm(`Roll ${flyApp} back to v${chosen.version}?`))
  ) {
    p.outro(pc.dim("Rollback cancelled."));
    return 1;
  }

  const code = await deps.runDeploy(args, opts.cwd);
  if (code !== 0) {
    deps.log.error("flyctl deploy failed.");
    p.outro(pc.red("Rollback failed."));
    return 1;
  }
  deps.log.success(`Rolled ${flyApp} back to v${chosen.version}.`);
  p.outro(pc.green("Rollback complete."));
  return 0;
}

type ResolvedTarget =
  | { appName: string; env: EnvironmentKind; flyApp: string; root: string }
  | { error: string };

/** Resolve which app + environment (and its concrete Fly app) to roll back. */
async function resolveTarget({
  config,
  opts,
  deps,
}: {
  config: DeploykitConfig;
  opts: InitOptions;
  deps: RollbackDeps;
}): Promise<ResolvedTarget> {
  const appNames = Object.keys(config.apps);
  let appName = opts.app;
  if (!appName) {
    if (appNames.length === 1) appName = appNames[0];
    else if (!opts.yes)
      appName =
        (await deps.select(
          "Which app?",
          appNames.map((a) => ({ value: a, label: a })),
        )) ?? undefined;
  }
  const app = appName ? config.apps[appName] : undefined;
  if (!appName || !app) {
    return {
      error: appName
        ? `Unknown app "${appName}". Known apps: ${appNames.join(", ")}.`
        : `--app is required (known apps: ${appNames.join(", ")}).`,
    };
  }

  const available = ROLLBACKABLE.filter((e) => app.environments[e]);
  if (available.length === 0)
    return {
      error: `App "${appName}" has no rollbackable environment (staging/production).`,
    };

  let env = opts.env;
  if (!env) {
    if (available.length === 1) env = available[0];
    else if (!opts.yes)
      env =
        ((await deps.select(
          "Which environment?",
          available.map((e) => ({ value: e, label: e })),
        )) as EnvironmentKind | null) ?? undefined;
  }
  if (!env || !available.includes(env)) {
    return {
      error: env
        ? `Environment "${env}" isn't rollbackable for "${appName}" (has: ${available.join(", ")}).`
        : `--env is required (available: ${available.join(", ")}).`,
    };
  }

  return {
    appName,
    env,
    flyApp: app.environments[env]?.name ?? "",
    root: app.root,
  };
}

/** Pick a release: `--to <version>` non-interactively, else prompt. */
async function chooseRelease({
  candidates,
  opts,
  deps,
}: {
  candidates: Release[];
  opts: InitOptions;
  deps: RollbackDeps;
}): Promise<Release | null> {
  if (opts.to) {
    const wanted = Number(opts.to);
    const match = candidates.find((r) => r.version === wanted);
    if (!match)
      deps.log.error(
        `No rollbackable release v${opts.to} (candidates: ${candidates
          .map((r) => `v${r.version}`)
          .join(", ")}).`,
      );
    return match ?? null;
  }
  if (opts.yes) {
    deps.log.error(
      "Non-interactive rollback needs an explicit --to <version>.",
    );
    return null;
  }
  const picked = await deps.select(
    "Roll back to which release?",
    candidates.map((r) => ({
      value: String(r.version),
      label: `v${r.version} · ${r.status || "?"}${r.createdAt ? ` · ${r.createdAt}` : ""}`,
    })),
  );
  return candidates.find((r) => String(r.version) === picked) ?? null;
}
