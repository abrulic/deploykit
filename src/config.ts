/**
 * Shared types for deploykit and the `deploykit.config.ts` file it generates.
 *
 * The generated config is the single source of truth: every Dockerfile, fly.toml
 * and workflow is regenerable from it, and the user owns it in their repo.
 */

export type MonorepoTool = "turbo" | "nx";
export type PackageManager = "pnpm" | "yarn" | "npm" | "bun";

/** How an app is built and served. Drives the runner stage of the Dockerfile. */
export type Framework =
  | "next"
  | "remix"
  | "astro"
  | "vite"
  | "node-server"
  | "static";

export type EnvironmentKind = "preview" | "staging" | "production";

/** When a deploy for a given environment fires. */
export type Trigger = "pr" | "push:main" | "manual";

export interface ProviderConfig {
  type: "fly";
  /** Fly organization slug, e.g. "my-org". */
  org: string;
  /** Default primary region, e.g. "iad". */
  region: string;
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
  /** Internal port the server listens on inside the container. */
  port: number;
  /** Names of internal workspace packages this app depends on. */
  internalDeps: string[];
  /**
   * Path globs that should trigger a redeploy of this app: its own dir plus
   * every internal dependency's dir. Used by the "changes" workflow job.
   */
  watchPaths: string[];
  environments: Partial<Record<EnvironmentKind, AppEnvironment>>;
  /**
   * Environment variable *names* this app needs (never values). Wired through
   * GitHub → Fly secrets in the workflow.
   */
  secrets: string[];
}

export interface DeploykitConfig {
  tool: MonorepoTool;
  packageManager: PackageManager;
  /** Node major version used in the generated Dockerfiles, e.g. "20". */
  nodeVersion: string;
  provider: ProviderConfig;
  /** Deployable apps keyed by their short name (last path segment). */
  apps: Record<string, AppConfig>;
  /** Optional Cloudflare DNS/CDN wiring for custom domains. */
  cloudflare?: CloudflareConfig;
}

/** Identity helper re-exported into the generated config for editor types. */
export const defineConfig = (config: DeploykitConfig) => config;

export const DEFAULT_PORTS: Record<Framework, number> = {
  next: 3000,
  remix: 3000,
  astro: 4321,
  vite: 4173,
  "node-server": 8080,
  static: 8080,
};
