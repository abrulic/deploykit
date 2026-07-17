import type { DeploykitConfig } from "./config.js";
import type { GeneratedFile } from "./generate/index.js";
import type { InitOptions } from "./prompts.js";
import { pc } from "./util/log.js";

export interface RenderPlanInput {
  config: DeploykitConfig;
  files: GeneratedFile[];
  opts: InitOptions;
}

/** Phase 3 — a human-readable summary of what will happen, shown before writing. */
export function renderPlan({ config, files, opts }: RenderPlanInput) {
  const lines: string[] = [];

  lines.push(pc.bold("Apps"));
  for (const [name, app] of Object.entries(config.apps)) {
    const envs = Object.keys(app.environments).join(", ") || "none";
    lines.push(
      `  ${pc.cyan(name)} ${pc.dim(`(${app.framework}, :${app.port})`)}  → ${envs}`,
    );
    if (app.internalDeps.length) {
      lines.push(pc.dim(`      deps: ${app.internalDeps.join(", ")}`));
    }
    if (app.secrets.length) {
      lines.push(pc.dim(`      secrets: ${app.secrets.join(", ")}`));
    }
  }

  lines.push("");
  lines.push(pc.bold("Files"));
  for (const f of files) {
    const tag = f.exists ? pc.yellow(" (exists — skip)") : pc.green(" (new)");
    lines.push(`  ${f.path}${tag}`);
  }

  lines.push("");
  lines.push(pc.bold("Provider"));
  lines.push(
    `  Fly.io · org ${pc.cyan(config.provider.org)} · region ${pc.cyan(config.provider.region)}`,
  );

  const flyApps = flyAppNames(config);
  lines.push("");
  lines.push(pc.bold("Provisioning"));
  if (opts.provision) {
    lines.push(`  Create Fly apps: ${flyApps.join(", ")}`);
    lines.push(`  Set GitHub secret: FLY_API_TOKEN`);
    if (hasEnv({ config, kind: "staging" }))
      lines.push(`  Create GitHub environment: staging`);
    if (hasEnv({ config, kind: "production" }))
      lines.push(`  Create GitHub environment: production (required reviewers)`);
  } else {
    lines.push(pc.dim("  skipped (pass --provision to create Fly apps + secrets)"));
  }

  lines.push("");
  lines.push(pc.bold("Pull request"));
  lines.push(
    opts.pr
      ? "  Commit generated files on a branch and open a PR."
      : pc.dim("  skipped (pass --pr to open a PR)"),
  );

  if (opts.dryRun) {
    lines.push("");
    lines.push(pc.yellow("Dry run — nothing will be written."));
  }

  return lines.join("\n");
}

export function flyAppNames(config: DeploykitConfig) {
  const names: string[] = [];
  for (const app of Object.values(config.apps)) {
    if (app.environments.staging) names.push(app.environments.staging.name);
    if (app.environments.production) names.push(app.environments.production.name);
  }
  return names;
}

const hasEnv = ({
  config,
  kind,
}: {
  config: DeploykitConfig;
  kind: "staging" | "production";
}) => Object.values(config.apps).some((a) => a.environments[kind]);
