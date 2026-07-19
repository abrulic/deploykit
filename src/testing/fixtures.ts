import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AppConfig, DeploykitConfig } from "../config.js";

/** Write a map of repo-relative paths → contents into a fresh temp dir. */
export function writeTree({ files }: { files: Record<string, string> }) {
  const root = mkdtempSync(join(tmpdir(), "deploykit-test-"));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, "utf8");
  }
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A Next.js app with every environment enabled. */
export const sampleWebApp: AppConfig = {
  root: "apps/web",
  packageName: "@acme/web",
  framework: "next",
  port: 3000,
  internalDeps: ["@acme/ui"],
  watchPaths: ["apps/web/**", "packages/ui/**", "package.json", "turbo.json"],
  environments: {
    preview: { name: "web-pr-{pr}", trigger: "pr" },
    staging: { name: "web-staging", trigger: "push:main" },
    production: { name: "web-prod", trigger: "manual" },
  },
  secrets: ["DATABASE_URL", "NEXTAUTH_SECRET"],
  buildEnv: ["NEXT_PUBLIC_API_URL"],
};

/** A Node server app with only staging — exercises per-app env omission. */
export const sampleApiApp: AppConfig = {
  root: "apps/api",
  packageName: "@acme/api",
  framework: "node-server",
  port: 8080,
  internalDeps: [],
  watchPaths: ["apps/api/**", "package.json", "turbo.json"],
  environments: {
    staging: { name: "api-staging", trigger: "push:main" },
  },
  secrets: [],
};

/** A representative resolved config used across generator tests. */
export const sampleConfig: DeploykitConfig = {
  tool: "turbo",
  packageManager: "pnpm",
  nodeVersion: "20",
  provider: { type: "fly", org: "acme", region: "iad" },
  apps: { web: sampleWebApp, api: sampleApiApp },
};
