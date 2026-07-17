import { describe, expect, it } from "vitest";
import { sampleConfig, sampleWebApp } from "../testing/fixtures.js";
import { generateFlyToml } from "./flytoml.js";

describe("generateFlyToml", () => {
  const toml = generateFlyToml({
    name: "web",
    app: sampleWebApp,
    config: sampleConfig,
  });

  it("sets the base app name and region", () => {
    expect(toml).toContain('app = "web"');
    expect(toml).toContain('primary_region = "iad"');
  });

  it("sets the internal port from the app config", () => {
    expect(toml).toContain("internal_port = 3000");
  });

  it("declares a single app process and vm", () => {
    expect(toml).toContain('processes = ["app"]');
    expect(toml).toContain("[[vm]]");
  });
});
