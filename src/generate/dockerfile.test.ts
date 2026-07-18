import { describe, expect, it } from "vitest";
import type { AppConfig, DeploykitConfig, Framework } from "../config.js";
import { sampleConfig } from "../testing/fixtures.js";
import { generateDockerfile } from "./dockerfile.js";

const appWith = (framework: Framework): AppConfig => ({
  root: "apps/app",
  packageName: "@acme/app",
  framework,
  port: 3000,
  internalDeps: [],
  watchPaths: [],
  environments: {},
  secrets: [],
});

const gen = (framework: Framework, config: DeploykitConfig = sampleConfig) =>
  generateDockerfile({ name: "app", app: appWith(framework), config });

describe("generateDockerfile", () => {
  it("prunes the workspace by package name", () => {
    expect(gen("next")).toContain("turbo prune @acme/app --docker");
  });

  it("uses the detected package manager commands", () => {
    expect(gen("next")).toContain("pnpm install --frozen-lockfile");
    const npmConfig: DeploykitConfig = { ...sampleConfig, packageManager: "npm" };
    expect(gen("next", npmConfig)).toContain("npx --yes turbo prune");
  });

  it("emits a Next standalone runner", () => {
    const out = gen("next");
    expect(out).toContain(".next/standalone");
    expect(out).toContain('CMD ["node", "apps/app/server.js"]');
  });

  it("emits a server runner that runs the start script", () => {
    const out = gen("node-server");
    expect(out).toContain('CMD ["pnpm","start"]');
  });

  it("emits a static server runner for astro/vite", () => {
    expect(gen("astro")).toContain("serve");
    expect(gen("vite")).toContain('"-s"'); // SPA fallback
  });

  it("honors the configured node version", () => {
    const config: DeploykitConfig = { ...sampleConfig, nodeVersion: "22" };
    expect(gen("next", config)).toContain("FROM node:22-slim AS base");
  });

  it("prefixes install env and injects prisma generate before build", () => {
    const app: AppConfig = {
      ...appWith("node-server"),
      prisma: [
        { packageName: "@acme/db", root: "packages/db", schema: "prisma/schema.prisma", hasConfig: false },
      ],
    };
    const config: DeploykitConfig = { ...sampleConfig, installEnv: { LEFTHOOK: "0" } };
    const out = generateDockerfile({ name: "app", app, config });
    expect(out).toContain("RUN LEFTHOOK=0 pnpm install --frozen-lockfile");
    // No prisma.config → the --schema flag is present.
    expect(out).toContain(
      'RUN cd packages/db && DATABASE_URL="postgresql://build:build@localhost:5432/build" pnpm exec prisma generate --schema ./prisma/schema.prisma',
    );
    // prisma generate must land before the build step.
    expect(out.indexOf("prisma generate")).toBeLessThan(out.indexOf("turbo run build"));
  });

  it("honors an explicit startCommand for a server app", () => {
    const app: AppConfig = {
      ...appWith("react-router"),
      serve: "server",
      startCommand: ["node", "./build/server/index.js"],
    };
    const out = generateDockerfile({ name: "app", app, config: sampleConfig });
    expect(out).toContain('CMD ["node","./build/server/index.js"]');
  });
});
