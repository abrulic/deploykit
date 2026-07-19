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

  it("emits no migration hook for an app without Prisma", () => {
    // sampleWebApp has no prisma target, so nothing DB-related is added.
    expect(toml).not.toContain("release_command");
    expect(toml).not.toContain("migrate deploy");
  });

  it("emits a COMMENTED, opt-in Prisma migration hook when detected", () => {
    const withPrisma = generateFlyToml({
      name: "web",
      app: {
        ...sampleWebApp,
        prisma: [
          {
            packageName: "@acme/db",
            root: "packages/db",
            schema: "prisma/schema.prisma",
            hasConfig: false,
          },
        ],
      },
      config: sampleConfig,
    });
    // The hook is present but entirely commented out — deploykit never runs it.
    expect(withPrisma).toContain("# [deploy]");
    expect(withPrisma).toContain(
      '#   release_command = "(cd packages/db && npx prisma migrate deploy --schema ./prisma/schema.prisma)"',
    );
    for (const line of withPrisma.split("\n")) {
      expect(line).not.toMatch(/^\s*release_command/); // never uncommented
      expect(line).not.toMatch(/^\s*\[deploy\]/);
    }
  });

  it("omits --schema in the hook when the package has a prisma config", () => {
    const withCfg = generateFlyToml({
      name: "web",
      app: {
        ...sampleWebApp,
        prisma: [
          {
            packageName: "@acme/db",
            root: "packages/db",
            schema: "prisma/schema.prisma",
            hasConfig: true,
          },
        ],
      },
      config: sampleConfig,
    });
    expect(withCfg).toContain("migrate deploy)");
    expect(withCfg).not.toContain("--schema");
  });
});
