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
    if (app.buildEnv?.length) {
      lines.push(pc.dim(`      build-time: ${app.buildEnv.join(", ")}`));
    }
  }

  lines.push("");
  lines.push(pc.bold("Files"));
  for (const f of files) {
    const tag =
      f.status === "new"
        ? pc.green(" (new)")
        : f.status === "identical"
          ? pc.dim(" (exists — unchanged)")
          : pc.yellow(" (exists — differs, kept; use --force to overwrite)");
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
    lines.push(
      pc.dim(
        opts.yes
          ? "  (auto)"
          : "  (offered next — confirm each step; existing resources are skipped)",
      ),
    );
    lines.push(`  Create Fly apps: ${flyApps.join(", ")}`);
    lines.push(
      `  Create Fly deploy token → set FLY_API_TOKEN ${pc.dim("(shows under Fly → Tokens)")}`,
    );
    if (hasEnv({ config, kind: "staging" }))
      lines.push(`  Create GitHub environment: staging`);
    if (hasEnv({ config, kind: "production" }))
      // Note: deploykit creates the environment but can't pick reviewers for
      // you — the approval gate only exists once reviewers are added (surfaced
      // again in next steps).
      lines.push(`  Create GitHub environment: production`);
    const secrets = secretNames(config);
    if (secrets.length)
      lines.push(`  Set app secrets (per environment): ${secrets.join(", ")}`);
    if (cf) {
      const hostCount = Object.values(config.apps)
        .flatMap((a) => [a.environments.staging, a.environments.production])
        .filter((e) => e?.hostname).length;
      lines.push(
        `  Cloudflare: ${hostCount} domain(s) — Fly certs, DNS, SSL/security/caching`,
      );
    }
  } else {
    lines.push(
      pc.dim("  skipped (pass --provision to create Fly apps + secrets)"),
    );
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
    if (app.environments.production)
      names.push(app.environments.production.name);
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

/**
 * Unique secret names across all configured apps — runtime secrets and
 * build-time vars alike: both are stored as GitHub secrets (the workflow just
 * forwards them differently: `flyctl secrets set` vs `--build-arg`).
 */
export function secretNames(config: DeploykitConfig) {
  const names = new Set<string>();
  for (const app of Object.values(config.apps)) {
    for (const s of app.secrets) names.add(s);
    for (const b of app.buildEnv ?? []) names.add(b);
  }
  return [...names].sort();
}

/** Where each configured environment's secrets live in GitHub. */
export interface SecretTarget {
  /**
   * The deploykit-managed environment kind, or undefined for a target that was
   * only discovered on the repo (i.e. not one deploykit configured).
   */
  kind?: EnvironmentKind;
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
    if (app.environments.preview) kinds.add("preview");
    if (app.environments.staging) kinds.add("staging");
    if (app.environments.production) kinds.add("production");
  }
  const targets: SecretTarget[] = [];
  if (kinds.has("preview"))
    targets.push({ kind: "preview", label: "preview (repo)" });
  if (kinds.has("staging"))
    targets.push({ kind: "staging", env: "staging", label: "staging" });
  if (kinds.has("production"))
    targets.push({
      kind: "production",
      env: "production",
      label: "production",
    });
  return targets;
}

/**
 * Combine deploykit's configured secret targets with the environments that
 * actually exist on the GitHub repo, so secrets can be set for environments a
 * user created themselves (named anything) — not just the ones deploykit
 * models. Configured targets come first (in their canonical order); any repo
 * environment not already configured is appended (sorted) as a target with no
 * `kind`, marking it as discovered rather than deploykit-managed. Falls back to
 * just the configured targets when the repo's environments can't be read.
 */
export function mergeSecretTargets({
  configTargets,
  ghEnvs,
}: {
  configTargets: SecretTarget[];
  ghEnvs: string[] | null;
}): SecretTarget[] {
  if (!ghEnvs || ghEnvs.length === 0) return configTargets;
  const configured = new Set(configTargets.map((t) => t.env).filter(Boolean));
  const extras = [...new Set(ghEnvs)]
    .filter((name) => !configured.has(name))
    .sort()
    .map((name): SecretTarget => ({ env: name, label: name }));
  return [...configTargets, ...extras];
}
