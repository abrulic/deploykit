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

  it("adds an HTTP health check on / by default (gates Fly auto-rollback)", () => {
    expect(toml).toContain("[[http_service.checks]]");
    expect(toml).toContain('method = "GET"');
    expect(toml).toContain('path = "/"');
    expect(toml).toContain('grace_period = "10s"');
  });

  it("uses a configured healthCheckPath when set", () => {
    const custom = generateFlyToml({
      name: "api",
      app: { ...sampleWebApp, healthCheckPath: "/health" },
      config: sampleConfig,
    });
    expect(custom).toContain('path = "/health"');
    expect(custom).not.toContain('path = "/"');
  });
});
