import type { DeploykitConfig, EnvironmentKind } from "./config.js";
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

  const cf = config.cloudflare;
  if (cf) {
    lines.push("");
    lines.push(pc.bold("Domains (Cloudflare)"));
    for (const app of Object.values(config.apps)) {
      for (const kind of ["staging", "production"] as const) {
        const env = app.environments[kind];
        if (env?.hostname)
          lines.push(
            `  ${pc.cyan(env.hostname)} ${pc.dim(`→ ${env.name}.fly.dev (${kind})`)}`,
          );
      }
    }
    lines.push(
      pc.dim(
        `  zone ${cf.zone} · ${cf.proxied ? "proxied" : "DNS-only"} · SSL ${cf.ssl} · TLS≥${cf.minTlsVersion}${cf.security ? " · security" : ""}${cf.cache ? " · caching" : ""}`,
      ),
    );
  }

  const flyApps = flyAppNames(config);
  const willProvision = !opts.yes || opts.provision;
  lines.push("");
  lines.push(pc.bold("Provisioning"));
  if (willProvision) {
    lines.push(pc.dim(opts.yes ? "  (auto)" : "  (offered next — confirm each step; existing resources are skipped)"));
    lines.push(`  Create Fly apps: ${flyApps.join(", ")}`);
    lines.push(`  Create Fly deploy token → set FLY_API_TOKEN ${pc.dim("(shows under Fly → Tokens)")}`);
    if (hasEnv({ config, kind: "staging" }))
      lines.push(`  Create GitHub environment: staging`);
    if (hasEnv({ config, kind: "production" }))
      lines.push(`  Create GitHub environment: production (required reviewers)`);
    const secrets = secretNames(config);
    if (secrets.length)
      lines.push(`  Set app secrets (per environment): ${secrets.join(", ")}`);
    if (cf) {
      const hostCount = Object.values(config.apps)
        .flatMap((a) => [a.environments.staging, a.environments.production])
        .filter((e) => e?.hostname).length;
      lines.push(`  Cloudflare: ${hostCount} domain(s) — Fly certs, DNS, SSL/security/caching`);
    }
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

/** Unique secret names across all configured apps. */
export function secretNames(config: DeploykitConfig) {
  const names = new Set<string>();
  for (const app of Object.values(config.apps)) {
    for (const s of app.secrets) names.add(s);
  }
  return [...names].sort();
}

/** Where each configured environment's secrets live in GitHub. */
export interface SecretTarget {
  kind: EnvironmentKind;
  /** GitHub environment name, or undefined for repo-level secrets. */
  env?: string;
  /** Short label for prompts/plan output. */
  label: string;
}

/**
 * Map the configured environments to GitHub secret targets. Preview jobs have
 * no GitHub `environment:` so they read repo-level secrets (env undefined);
 * staging and production read their own environment's secrets.
 */
export function secretTargets(config: DeploykitConfig): SecretTarget[] {
  const kinds = new Set<EnvironmentKind>();
  for (const app of Object.values(config.apps)) {
    for (const kind of Object.keys(app.environments) as EnvironmentKind[]) {
      kinds.add(kind);
    }
  }
  const targets: SecretTarget[] = [];
  if (kinds.has("preview")) targets.push({ kind: "preview", label: "preview (repo)" });
  if (kinds.has("staging")) targets.push({ kind: "staging", env: "staging", label: "staging" });
  if (kinds.has("production"))
    targets.push({ kind: "production", env: "production", label: "production" });
  return targets;
}
