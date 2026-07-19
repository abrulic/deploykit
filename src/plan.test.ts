import { describe, expect, it } from "vitest";
import type { DeploykitConfig } from "./config.js";
import {
  flyAppNames,
  mergeSecretTargets,
  secretNames,
  secretTargets,
} from "./plan.js";
import { sampleConfig, sampleWebApp } from "./testing/fixtures.js";

describe("flyAppNames", () => {
  it("lists staging and production app names, skipping preview", () => {
    expect(flyAppNames(sampleConfig)).toEqual([
      "web-staging",
      "web-prod",
      "api-staging",
    ]);
  });

  it("returns [] when only preview environments exist", () => {
    const previewOnly: DeploykitConfig = {
      ...sampleConfig,
      apps: {
        web: {
          ...sampleWebApp,
          environments: { preview: { name: "web-pr-{pr}", trigger: "pr" } },
        },
      },
    };
    expect(flyAppNames(previewOnly)).toEqual([]);
  });
});

describe("secretNames", () => {
  it("returns the sorted union of runtime secrets and build-time vars", () => {
    // web: DATABASE_URL, NEXTAUTH_SECRET + build-time NEXT_PUBLIC_API_URL; api: none.
    // Build vars are GitHub secrets too — they just flow via --build-arg.
    expect(secretNames(sampleConfig)).toEqual([
      "DATABASE_URL",
      "NEXTAUTH_SECRET",
      "NEXT_PUBLIC_API_URL",
    ]);
  });

  it("dedupes names shared across apps", () => {
    const config: DeploykitConfig = {
      ...sampleConfig,
      apps: {
        web: { ...sampleWebApp, secrets: ["A", "B"], buildEnv: [] },
        api: { ...sampleConfig.apps.api!, secrets: ["B", "C"] },
      },
    };
    expect(secretNames(config)).toEqual(["A", "B", "C"]);
  });
});

describe("secretTargets", () => {
  it("maps preview to repo-level and staging/production to their environments", () => {
    // sampleConfig: web has all three envs, api has staging.
    expect(secretTargets(sampleConfig)).toEqual([
      { kind: "preview", label: "preview (repo)" },
      { kind: "staging", env: "staging", label: "staging" },
      { kind: "production", env: "production", label: "production" },
    ]);
  });

  it("includes only the environments that are configured", () => {
    const stagingOnly: DeploykitConfig = {
      ...sampleConfig,
      apps: {
        api: {
          ...sampleConfig.apps.api!,
          environments: {
            staging: { name: "api-staging", trigger: "push:main" },
          },
        },
      },
    };
    expect(secretTargets(stagingOnly)).toEqual([
      { kind: "staging", env: "staging", label: "staging" },
    ]);
  });
});

describe("mergeSecretTargets", () => {
  const configTargets = secretTargets(sampleConfig); // preview, staging, production

  it("falls back to the configured targets when the repo can't be read", () => {
    expect(mergeSecretTargets({ configTargets, ghEnvs: null })).toEqual(
      configTargets,
    );
    expect(mergeSecretTargets({ configTargets, ghEnvs: [] })).toEqual(
      configTargets,
    );
  });

  it("appends repo environments deploykit didn't configure, sorted, with no kind", () => {
    const merged = mergeSecretTargets({
      configTargets,
      ghEnvs: ["staging", "production", "qa-eu", "demo"],
    });
    expect(merged).toEqual([
      { kind: "preview", label: "preview (repo)" },
      { kind: "staging", env: "staging", label: "staging" },
      { kind: "production", env: "production", label: "production" },
      { env: "demo", label: "demo" },
      { env: "qa-eu", label: "qa-eu" },
    ]);
  });

  it("dedupes repeated repo environments", () => {
    const merged = mergeSecretTargets({
      configTargets: [],
      ghEnvs: ["qa", "qa", "prod-eu"],
    });
    expect(merged).toEqual([
      { env: "prod-eu", label: "prod-eu" },
      { env: "qa", label: "qa" },
    ]);
  });
});
