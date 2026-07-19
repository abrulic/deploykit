import * as p from "@clack/prompts";
import { type DeploykitConfig, extraRegions } from "./config.js";
import { exec, execInteractive } from "./util/exec.js";
import { pc } from "./util/log.js";

/** A name/value pair captured during provisioning (a secret or build-time var). */
export interface NamedValue {
  name: string;
  value: string;
}

/** One app to deploy: its Fly app, source root, and the values to feed the build. */
export interface DeployTarget {
  /** Logical app name (the workspace package's short name). */
  app: string;
  /** Concrete Fly app name, e.g. "acme-web-staging". */
  flyApp: string;
  /** App source root relative to the repo, e.g. "apps/web" — where fly.toml/Dockerfile live. */
  root: string;
  /** Runtime secrets to stage on the Fly app before deploying. */
  secrets: NamedValue[];
  /** Build-time vars forwarded as `--build-arg`. */
  buildArgs: NamedValue[];
  /** Custom domain for staging, when one is configured (informational). */
  hostname?: string;
}

/**
 * The staging apps to deploy, each paired with the secrets/build-args the user
 * entered for staging during provisioning. Staging is the first-deploy target:
 * it has a stable Fly name (unlike per-PR previews) and deploys automatically
 * on merge afterwards (unlike the gated production env).
 *
 * `captured` holds every value set this run keyed by name; each app takes only
 * the ones it declares (runtime secrets vs build-time vars split by config), so
 * an unrelated app's secrets are never staged onto it.
 */
export function deployTargets({
  config,
  captured,
}: {
  config: DeploykitConfig;
  captured: NamedValue[];
}): DeployTarget[] {
  const byName = new Map(captured.map((e) => [e.name, e.value]));
  const pick = (names: string[]): NamedValue[] =>
    names.flatMap((n) => {
      const value = byName.get(n);
      return value === undefined ? [] : [{ name: n, value }];
    });

  const targets: DeployTarget[] = [];
  for (const [app, cfg] of Object.entries(config.apps)) {
    const staging = cfg.environments.staging;
    if (!staging) continue;
    targets.push({
      app,
      flyApp: staging.name,
      root: cfg.root,
      secrets: pick(cfg.secrets),
      buildArgs: pick(cfg.buildEnv ?? []),
      hostname: staging.hostname,
    });
  }
  return targets;
}

/**
 * The `flyctl deploy` argv for a target — the local mirror of the generated
 * workflow's deploy step: build context is the repo root, config/Dockerfile are
 * read from the app root, `--remote-only` builds on Fly's builder (no local
 * Docker), `--ha=false` boots a single staging machine, and each build-time var
 * is forwarded as `--build-arg`.
 */
export function deployArgs(target: DeployTarget): string[] {
  const args = [
    "deploy",
    ".",
    "--config",
    `${target.root}/fly.toml`,
    "--dockerfile",
    `${target.root}/Dockerfile`,
    "--app",
    target.flyApp,
    "--remote-only",
    "--ha=false",
  ];
  for (const b of target.buildArgs)
    args.push("--build-arg", `${b.name}=${b.value}`);
  return args;
}

/** The public URL a freshly deployed staging app answers on (always valid immediately). */
export const flyUrl = (flyApp: string) => `https://${flyApp}.fly.dev`;

/** Injected IO seams, so the orchestration is testable without a real deploy. */
export interface DeployDeps {
  confirm: (message: string) => Promise<boolean>;
  stageSecret: (
    flyApp: string,
    secret: NamedValue,
    cwd: string,
  ) => Promise<boolean>;
  runDeploy: (args: string[], cwd: string) => Promise<number>;
  /** Scale one machine into an extra region after the deploy. */
  scaleRegion: (
    flyApp: string,
    region: string,
    cwd: string,
  ) => Promise<boolean>;
  log: {
    warn: (s: string) => void;
    success: (s: string) => void;
    info: (s: string) => void;
    step: (s: string) => void;
  };
}

const defaultDeps: DeployDeps = {
  confirm: async (message) =>
    (await p.confirm({ message, initialValue: false })) === true,
  stageSecret: async (flyApp, secret, cwd) =>
    (
      await exec({
        cmd: "flyctl",
        args: [
          "secrets",
          "set",
          "--stage",
          "--app",
          flyApp,
          `${secret.name}=${secret.value}`,
        ],
        cwd,
      })
    ).code === 0,
  runDeploy: (args, cwd) => execInteractive({ cmd: "flyctl", args, cwd }),
  scaleRegion: async (flyApp, region, cwd) =>
    (
      await exec({
        cmd: "flyctl",
        args: [
          "scale",
          "count",
          "1",
          "--region",
          region,
          "--app",
          flyApp,
          "--yes",
        ],
        cwd,
      })
    ).code === 0,
  log: {
    warn: (s) => p.log.warn(s),
    success: (s) => p.log.success(pc.green(s)),
    info: (s) => p.log.info(s),
    step: (s) => p.log.step(s),
  },
};

export interface FirstDeployInput {
  config: DeploykitConfig;
  cwd: string;
  /** Whether flyctl is authenticated — a real deploy needs it. */
  flyReady: boolean;
  /** Skip the confirmation prompt (set when `--deploy` was passed explicitly). */
  assumeYes?: boolean;
  /** Values entered for staging during provisioning, used to stage secrets/build-args. */
  captured?: NamedValue[];
  deps?: Partial<DeployDeps>;
}

/**
 * Build and boot the staging app(s) on Fly right after setup, so `init` can end
 * on a live URL instead of "now push to deploy". This is a real, billable
 * deploy, so it's strictly opt-in: skipped without flyctl auth, and gated behind
 * a confirm (or an explicit `--deploy` in non-interactive runs). Each app's
 * outcome is independent — one failure doesn't abort the rest.
 */
export async function firstDeploy({
  config,
  cwd,
  flyReady,
  assumeYes = false,
  captured = [],
  deps,
}: FirstDeployInput): Promise<void> {
  const d = { ...defaultDeps, ...deps };

  const targets = deployTargets({ config, captured });
  if (targets.length === 0) return;

  if (!flyReady) {
    d.log.warn(
      "Skipping first deploy — flyctl isn't authenticated. Merge to main (or run `flyctl deploy`) to deploy.",
    );
    return;
  }

  const names = targets.map((t) => t.flyApp).join(", ");
  if (!assumeYes) {
    if (
      !(await d.confirm(
        `Deploy ${targets.length} app(s) to Fly staging now (${names})? This builds and boots real machines.`,
      ))
    ) {
      d.log.info("Skipping first deploy — merge to main to deploy via CI.");
      return;
    }
  }

  for (const t of targets) {
    d.log.step(`Deploying ${pc.bold(t.app)} → ${t.flyApp}`);

    // Stage secrets first (mirrors CI): applied on the deploy that follows.
    for (const s of t.secrets) {
      const ok = await d.stageSecret(t.flyApp, s, cwd);
      if (!ok)
        d.log.warn(
          `Couldn't stage secret ${s.name} on ${t.flyApp} — continuing.`,
        );
    }

    const code = await d.runDeploy(deployArgs(t), cwd);
    if (code === 0) {
      // Mirror CI: fan the app out to any configured extra regions.
      for (const r of extraRegions(config.provider)) {
        const ok = await d.scaleRegion(t.flyApp, r, cwd);
        if (ok) d.log.info(pc.dim(`scaled ${t.flyApp} into ${r}`));
        else d.log.warn(`Couldn't scale ${t.flyApp} into ${r} — continuing.`);
      }
      if (t.hostname) {
        // Custom domain is the real destination — lead with it, keep the
        // fly.dev address as the dim fallback that answers immediately.
        d.log.success(`Deployed ${t.app} → https://${t.hostname}`);
        d.log.info(
          pc.dim(
            `${flyUrl(t.flyApp)} answers now · https://${t.hostname} serves once Cloudflare DNS propagates`,
          ),
        );
      } else {
        d.log.success(`Deployed ${t.app} → ${flyUrl(t.flyApp)}`);
      }
    } else {
      d.log.warn(
        `Deploy of ${t.app} didn't finish (flyctl exit ${code}) — see the log above.`,
      );
    }
  }
}
