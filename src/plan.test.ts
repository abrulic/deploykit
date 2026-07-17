import { describe, expect, it } from "vitest";
import type { DeploykitConfig } from "./config.js";
import { flyAppNames } from "./plan.js";
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
