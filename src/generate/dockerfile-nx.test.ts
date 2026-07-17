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
