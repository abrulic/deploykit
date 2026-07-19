import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeploykitConfig } from "./config.js";
import { domainTargets, provisionCloudflare } from "./provision-cloudflare.js";

const baseApp = {
  root: "apps/web",
  packageName: "@acme/web",
  framework: "vite" as const,
  port: 4173,
  internalDeps: [],
  watchPaths: ["apps/web/**"],
  secrets: [],
};

function configWith(
  envs: DeploykitConfig["apps"]["web"]["environments"],
): DeploykitConfig {
  return {
    tool: "nx",
    packageManager: "pnpm",
    nodeVersion: "20",
    provider: { type: "fly", org: "acme", region: "iad" },
    apps: { web: { ...baseApp, environments: envs } },
    cloudflare: {
      zone: "example.com",
      proxied: true,
      ssl: "strict",
      alwaysUseHttps: true,
      minTlsVersion: "1.2",
      security: true,
      cache: true,
    },
  };
}

describe("domainTargets", () => {
  it("collects staging/production hostnames and ignores previews + missing ones", () => {
    const config = configWith({
      preview: {
        name: "web-pr-{pr}",
        trigger: "pr",
        hostname: "ignored.example.com",
      },
      staging: {
        name: "web-staging",
        trigger: "push:main",
        hostname: "staging.example.com",
      },
      production: { name: "web-prod", trigger: "manual" }, // no hostname → skipped
    });
    expect(domainTargets(config)).toEqual([
      { hostname: "staging.example.com", flyApp: "web-staging" },
    ]);
  });
});

describe("provisionCloudflare", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns nothing when there's no cloudflare config", async () => {
    const config = configWith({
      staging: { name: "web-staging", trigger: "push:main" },
    });
    delete config.cloudflare;
    expect(await provisionCloudflare({ config, token: "t", cwd: "." })).toEqual(
      [],
    );
  });

  it("stops with a failed step when the zone can't be verified", async () => {
    // getZone returns an empty list → zone not found / not owned.
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, errors: [], result: [] }),
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const config = configWith({
      staging: {
        name: "web-staging",
        trigger: "push:main",
        hostname: "staging.example.com",
      },
    });
    const results = await provisionCloudflare({ config, token: "t", cwd: "." });
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.label).toContain("example.com");
    // Only the zone lookup happened — no cert/DNS calls after the short-circuit.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
