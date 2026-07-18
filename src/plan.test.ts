import { describe, expect, it } from "vitest";
import type { DeploykitConfig } from "./config.js";
import { flyAppNames, secretNames, secretTargets } from "./plan.js";
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
  it("returns the sorted union of app secrets", () => {
    // web: DATABASE_URL, NEXTAUTH_SECRET; api: none
    expect(secretNames(sampleConfig)).toEqual(["DATABASE_URL", "NEXTAUTH_SECRET"]);
  });

  it("dedupes names shared across apps", () => {
    const config: DeploykitConfig = {
      ...sampleConfig,
      apps: {
        web: { ...sampleWebApp, secrets: ["A", "B"] },
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
          environments: { staging: { name: "api-staging", trigger: "push:main" } },
        },
      },
    };
    expect(secretTargets(stagingOnly)).toEqual([
      { kind: "staging", env: "staging", label: "staging" },
    ]);
  });
});
