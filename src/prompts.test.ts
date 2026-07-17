import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DetectedApp, Detection } from "./detect.js";
import { buildConfig, type InitOptions } from "./prompts.js";

const app: DetectedApp = {
  name: "web",
  root: "apps/web",
  packageName: "@acme/web",
  framework: "next",
  deployable: true,
  port: 3000,
  internalDeps: ["@acme/ui"],
  watchPaths: ["apps/web/**", "packages/ui/**"],
  secrets: ["DATABASE_URL"],
  hasDockerfile: false,
  hasFlyToml: false,
};

const detection: Detection = {
  tool: "turbo",
  packageManager: "pnpm",
  nodeVersion: "20",
  apps: [app],
  libs: [],
  hasExistingWorkflows: false,
};

const baseOpts: InitOptions = {
  yes: true,
  dryRun: false,
  provision: false,
  pr: false,
  force: false,
  cwd: "/tmp",
};

describe("buildConfig (non-interactive)", () => {
  const savedOrg = process.env.FLY_ORG;
  beforeEach(() => {
    delete process.env.FLY_ORG;
  });
  afterEach(() => {
    if (savedOrg === undefined) delete process.env.FLY_ORG;
    else process.env.FLY_ORG = savedOrg;
    vi.restoreAllMocks();
  });

  it("builds a config from detection and flags", async () => {
    const config = await buildConfig({
      detection,
      opts: { ...baseOpts, org: "acme", region: "sjc" },
    });
    expect(config).not.toBeNull();
    expect(config?.provider).toEqual({ type: "fly", org: "acme", region: "sjc" });
    expect(Object.keys(config?.apps ?? {})).toEqual(["web"]);
    expect(config?.apps.web?.environments).toMatchObject({
      preview: { name: "web-pr-{pr}" },
      staging: { name: "web-staging" },
      production: { name: "web-prod" },
    });
  });

  it("defaults the region to iad when not provided", async () => {
    const config = await buildConfig({ detection, opts: { ...baseOpts, org: "acme" } });
    expect(config?.provider.region).toBe("iad");
  });

  it("reads the org from FLY_ORG when the flag is absent", async () => {
    process.env.FLY_ORG = "envorg";
    const config = await buildConfig({ detection, opts: baseOpts });
    expect(config?.provider.org).toBe("envorg");
  });

  it("returns null when no org can be resolved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const config = await buildConfig({ detection, opts: baseOpts });
    expect(config).toBeNull();
  });
});
