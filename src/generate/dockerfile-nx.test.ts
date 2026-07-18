import { describe, expect, it } from "vitest";
import type { AppConfig, DeploykitConfig, Framework } from "../config.js";
import { sampleConfig } from "../testing/fixtures.js";
import { generateDockerfile } from "./dockerfile.js";

const nxConfig: DeploykitConfig = { ...sampleConfig, tool: "nx" };

const appWith = (framework: Framework): AppConfig => ({
  root: "apps/app",
  packageName: "app",
  framework,
  port: 3000,
  internalDeps: [],
  watchPaths: [],
  environments: {},
  secrets: [],
});

const gen = (framework: Framework) =>
  generateDockerfile({ name: "app", app: appWith(framework), config: nxConfig });

describe("generateDockerfile (Nx)", () => {
  it("builds via `nx build <project>` instead of turbo prune", () => {
    const out = gen("node-server");
    expect(out).toContain("nx build app --configuration=production");
    expect(out).not.toContain("turbo prune");
  });

  it("copies from the Nx default output dir dist/<projectRoot>", () => {
    expect(gen("node-server")).toContain("/app/dist/apps/app");
  });

  it("emits a Node runner that installs prod deps and runs main.js", () => {
    const out = gen("node-server");
    expect(out).toContain("pnpm install --prod");
    expect(out).toContain('CMD ["node", "main.js"]');
  });

  it("emits a Next standalone runner from the Nx output", () => {
    expect(gen("next")).toContain("dist/apps/app/.next/standalone");
  });

  it("emits a static server runner for astro/vite", () => {
    expect(gen("astro")).toContain("serve");
    expect(gen("vite")).toContain('"-s"');
  });
});

describe("generateDockerfile (Nx, package-based / server model)", () => {
  const pkgBasedConfig: DeploykitConfig = { ...nxConfig, nxIntegrated: false };

  const serverApp: AppConfig = {
    root: "test-apps/storefront-app",
    packageName: "storefront-app",
    framework: "react-router",
    serve: "server",
    port: 3000,
    internalDeps: ["@acme/db"],
    watchPaths: [],
    environments: {},
    secrets: [],
    prisma: [
      { packageName: "@acme/db", root: "packages/db", schema: "prisma/schema.prisma", hasConfig: true },
    ],
  };

  const out = generateDockerfile({ name: "storefront-app", app: serverApp, config: pkgBasedConfig });

  it("ships the built workspace and runs the app's start script", () => {
    expect(out).toContain("COPY --from=build --chown=appuser:nodejs /app ./");
    expect(out).toContain("WORKDIR /app/test-apps/storefront-app");
    expect(out).toContain('CMD ["pnpm","start"]');
    expect(out).not.toContain("main.js");
  });

  it("drops --configuration=production for package-based Nx", () => {
    expect(out).toContain("nx build storefront-app\n");
    expect(out).not.toContain("--configuration=production");
  });

  it("neutralizes the prepare hook and generates the Prisma client", () => {
    const withEnv = generateDockerfile({
      name: "storefront-app",
      app: serverApp,
      config: { ...pkgBasedConfig, installEnv: { LEFTHOOK: "0" } },
    });
    expect(withEnv).toContain("RUN LEFTHOOK=0 pnpm install --frozen-lockfile");
    expect(withEnv).toContain(
      'RUN cd packages/db && DATABASE_URL="postgresql://build:build@localhost:5432/build" pnpm exec prisma generate',
    );
    // hasConfig → no --schema flag.
    expect(withEnv).not.toContain("--schema");
  });

  it("honors an explicit startCommand over the package manager's start", () => {
    const withCmd = generateDockerfile({
      name: "storefront-app",
      app: { ...serverApp, startCommand: ["node", "./build/server/index.js"] },
      config: pkgBasedConfig,
    });
    expect(withCmd).toContain('CMD ["node","./build/server/index.js"]');
  });
});
