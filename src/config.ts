/**
 * Shared types for deploykit and the `deploykit.config.ts` file it generates.
 *
 * The generated config is the single source of truth: every Dockerfile, fly.toml
 * and workflow is regenerable from it, and the user owns it in their repo.
 */

export type MonorepoTool = "turbo" | "nx";
export type PackageManager = "pnpm" | "yarn" | "npm" | "bun";

/**
 * The app's framework. A detection *hint* (drives DEFAULT_PORTS, the Next
 * special-case, and the plan label) — the Dockerfile runner branches on
 * `AppConfig.serve`, not on this.
 */
export type Framework =
  | "next"
  | "remix"
  | "react-router"
  | "astro"
  | "vite"
  | "node-server"
  | "static";

/** How the runner stage serves the app. Decoupled from `Framework`. */
export type ServeModel = "static" | "server";

/**
 * A workspace package that ships a Prisma schema. Its client isn't generated on
 * install under pnpm 10 / Prisma 7, so the Dockerfile runs `prisma generate`
 * before the build for every such package in an app's dependency closure.
 */
export interface PrismaTarget {
  /** Package name, used as the `--filter` / run target. */
  packageName: string;
  /** Workspace-relative package dir, e.g. "packages/database". */
  root: string;
  /** Schema path relative to the package root, e.g. "prisma/schema.prisma". */
  schema: string;
  /** True when the package has a prisma.config.{ts,js} (then `--schema` is omitted). */
  hasConfig: boolean;
}

export type EnvironmentKind = "preview" | "staging" | "production";

/** When a deploy for a given environment fires. */
export type Trigger = "pr" | "push:main" | "manual";

export interface ProviderConfig {
  type: "fly";
  /** Fly organization slug, e.g. "my-org". */
  org: string;
  /** Default primary region, e.g. "iad". */
  region: string;
  /**
   * Extra Fly regions to also run in, beyond `region`. After each non-preview
   * deploy, one machine is scaled up in every region here that isn't already the
   * primary. Omitted/empty → single-region (the default, byte-identical output).
   *
   * For STATELESS apps only: deploykit does not model database locality, so a
   * machine here still talks to whatever single-region `DATABASE_URL` you set —
   * expect high write latency from far regions. Don't use this for stateful apps
   * without a read-replica / fly-replay strategy of your own.
   */
  regions?: string[];
}

/**
 * Regions to scale into beyond the primary: `provider.regions` with the primary
 * removed and duplicates dropped. Empty (the default) means single-region, and
 * every generator falls back to today's exact output.
 */
export function extraRegions(provider: ProviderConfig): string[] {
  const out: string[] = [];
  for (const r of provider.regions ?? []) {
    if (r && r !== provider.region && !out.includes(r)) out.push(r);
  }
  return out;
}

export interface AppEnvironment {
  /**
   * Fly app name for this environment. Preview uses the `{pr}` placeholder,
   * e.g. "web-pr-{pr}"; staging/production are concrete, e.g. "web-staging".
   */
  name: string;
  trigger: Trigger;
  /**
   * Custom domain served for this environment, e.g. "app.example.com".
   * Only meaningful for staging/production — previews stay on `*.fly.dev`.
   * When set (and a `cloudflare` block exists), deploykit issues a Fly cert
   * and wires the Cloudflare DNS records.
   */
  hostname?: string;
}

export type CloudflareSslMode = "off" | "flexible" | "full" | "strict";
export type MinTlsVersion = "1.0" | "1.1" | "1.2" | "1.3";

/**
 * Cloudflare DNS/CDN settings for the custom domains. Optional — omit it and
 * deploykit leaves DNS alone (apps stay reachable on `*.fly.dev`).
 */
export interface CloudflareConfig {
  /** Registrable zone that owns the hostnames, e.g. "example.com". */
  zone: string;
  /** Route traffic through Cloudflare's proxy (orange cloud) vs DNS-only. */
  proxied: boolean;
  /** Zone SSL mode. Use "strict" with proxied Fly apps to avoid redirect loops. */
  ssl: CloudflareSslMode;
  /** Turn on the "Always Use HTTPS" edge redirect. */
  alwaysUseHttps: boolean;
  /** Minimum TLS version accepted at the edge. */
  minTlsVersion: MinTlsVersion;
  /** Apply a security baseline (security level + bot fight mode, managed WAF best-effort). */
  security: boolean;
  /** Add cache rules for static assets (+ browser cache TTL). */
  cache: boolean;
}

export interface AppConfig {
  /** Workspace-relative directory, e.g. "apps/web". */
  root: string;
  /** name field from the app's package.json. */
  packageName: string;
  framework: Framework;
  /**
   * How the runner serves the app: "server" runs a long-running process (SSR,
   * node server); "static" serves the built files. Omitted on configs generated
   * before this field existed — generators then fall back to the framework.
   */
  serve?: ServeModel;
  /**
   * Exec-form CMD for a server app, e.g. ["node", "dist/server.js"]. Omitted for
   * the common case, where the runner runs the app's own `start` script via the
   * package manager (which resolves node_modules/.bin and honors the script).
   */
  startCommand?: string[];
  /**
   * For static apps: the directory (relative to /app in the build stage) whose
   * contents are served. Omitted → derived from the tool + framework.
   */
  outputDir?: string;
  /** For static apps: serve with SPA history fallback (`serve -s`). */
  spa?: boolean;
  /**
   * Prisma packages in this app's dependency closure whose client must be
   * generated at build time. Empty/omitted when the app uses no Prisma.
   */
  prisma?: PrismaTarget[];
  /** Internal port the server listens on inside the container. */
  port: number;
  /**
   * HTTP path Fly polls to decide a release is healthy. A failing check keeps
   * the previous machines serving (auto-rollback on a bad deploy). Defaults to
   * "/", which most apps answer with a 2xx/3xx; set it to a lightweight endpoint
   * (e.g. "/health") for an API whose "/" 404s, or it would wedge the deploy.
   */
  healthCheckPath?: string;
  /** Names of internal workspace packages this app depends on. */
  internalDeps: string[];
  /**
   * Path globs that should trigger a redeploy of this app: its own dir plus
   * every internal dependency's dir. Used by the "changes" workflow job.
   */
  watchPaths: string[];
  environments: Partial<Record<EnvironmentKind, AppEnvironment>>;
  /**
   * *Runtime* environment variable names this app needs (never values). Wired
   * through GitHub secrets → `flyctl secrets set` in the workflow.
   */
  secrets: string[];
  /**
   * *Build-time* variable names — values baked into the bundle during
   * `docker build` (client-exposed prefixes like NEXT_PUBLIC_/VITE_, and every
   * var of a static app, which has no runtime to read env from). Wired through
   * GitHub secrets → `flyctl deploy --build-arg` + Dockerfile ARG/ENV.
   */
  buildEnv?: string[];
}

export interface DeploykitConfig {
  tool: MonorepoTool;
  packageManager: PackageManager;
  /** Node major version used in the generated Dockerfiles, e.g. "20". */
  nodeVersion: string;
  /**
   * Project prefix for every generated Fly app name (e.g. "acme-shop" →
   * "acme-shop-web-staging"). Fly app names are **globally** unique across all
   * Fly users, so bare names like "web-staging" are almost always taken.
   * Defaults to the root package name / repo dir; omitted → no prefix
   * (pre-prefix configs keep their old names).
   */
  namePrefix?: string;
  provider: ProviderConfig;
  /** Deployable apps keyed by their short name (last path segment). */
  apps: Record<string, AppConfig>;
  /** Optional Cloudflare DNS/CDN wiring for custom domains. */
  cloudflare?: CloudflareConfig;
  /**
   * Signals for neutralizing `prepare` git-hook installers that fail in the
   * image (the hook binary needs `git`, which the slim image lacks). `HUSKY=0`
   * is emitted as an env prefix on the install step; `LEFTHOOK=0` marks a
   * lefthook hook, which honors the var too late to help, so the install skips
   * lifecycle scripts (`--ignore-scripts`) instead of prefixing it. See
   * `installLine`.
   */
  installEnv?: Record<string, string>;
  /**
   * Nx only: true = integrated repo (project.json, outputs at dist/<root>);
   * false = package-based (per-package package.json, outputs in the package
   * dir). Omitted → treated as integrated for backward compatibility.
   */
  nxIntegrated?: boolean;
}

/** Identity helper re-exported into the generated config for editor types. */
export const defineConfig = (config: DeploykitConfig) => config;

export const DEFAULT_PORTS: Record<Framework, number> = {
  next: 3000,
  remix: 3000,
  "react-router": 3000,
  astro: 4321,
  vite: 4173,
  "node-server": 8080,
  static: 8080,
};
