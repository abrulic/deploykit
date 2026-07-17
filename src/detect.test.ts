import { afterEach, describe, expect, it } from "vitest";
import { detect, detectFramework } from "./detect.js";
import { writeTree } from "./testing/fixtures.js";

describe("detectFramework", () => {
  it("maps known deps to frameworks", () => {
    expect(detectFramework({ dependencies: { next: "14" } })).toBe("next");
    expect(detectFramework({ dependencies: { "@remix-run/node": "2" } })).toBe("remix");
    expect(detectFramework({ dependencies: { astro: "4" } })).toBe("astro");
    expect(detectFramework({ dependencies: { fastify: "4" } })).toBe("node-server");
    expect(detectFramework({ dependencies: { express: "4" } })).toBe("node-server");
    expect(detectFramework({ devDependencies: { vite: "5" } })).toBe("vite");
  });

  it("prefers next over a bundled vite", () => {
    expect(
      detectFramework({ dependencies: { next: "14" }, devDependencies: { vite: "5" } }),
    ).toBe("next");
  });

  it("returns null for a plain library", () => {
    expect(detectFramework({ dependencies: { react: "18" } })).toBeNull();
    expect(detectFramework({})).toBeNull();
  });
});

const MONOREPO = {
  "turbo.json": "{}",
  "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
  ".nvmrc": "20\n",
  ".env.example": "SENTRY_DSN=\n",
  "package.json": JSON.stringify({ name: "root", packageManager: "pnpm@9.0.0" }),
  "apps/web/package.json": JSON.stringify({
    name: "@acme/web",
    scripts: { start: "next start" },
    dependencies: { next: "14", "@acme/ui": "workspace:*" },
  }),
  "apps/web/.env.example": "DATABASE_URL=\n",
  "apps/api/package.json": JSON.stringify({
    name: "@acme/api",
    scripts: { start: "node dist/index.js" },
    dependencies: { fastify: "4" },
  }),
  "apps/api/src/index.ts": "const k = process.env.API_KEY;\n",
  "packages/ui/package.json": JSON.stringify({
    name: "@acme/ui",
    devDependencies: { vite: "5" },
  }),
  "packages/config/package.json": JSON.stringify({ name: "@acme/config" }),
};

describe("detect", () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it("classifies apps and libs in a turbo monorepo", () => {
    const tree = writeTree({ files: MONOREPO });
    cleanup = tree.cleanup;
    const result = detect(tree.root);

    expect(result.tool).toBe("turbo");
    expect(result.packageManager).toBe("pnpm");
    expect(result.nodeVersion).toBe("20");
    expect(result.apps.map((a) => a.name)).toEqual(["api", "web"]);
    expect(result.libs.map((l) => l.name).sort()).toEqual(["config", "ui"]);
  });

  it("resolves internal deps and per-framework ports", () => {
    const tree = writeTree({ files: MONOREPO });
    cleanup = tree.cleanup;
    const { apps } = detect(tree.root);
    const web = apps.find((a) => a.name === "web");
    const api = apps.find((a) => a.name === "api");

    expect(web?.framework).toBe("next");
    expect(web?.port).toBe(3000);
    expect(web?.internalDeps).toContain("@acme/ui");
    expect(api?.framework).toBe("node-server");
    expect(api?.port).toBe(8080);
  });

  it("collects secret names from env files and source scans", () => {
    const tree = writeTree({ files: MONOREPO });
    cleanup = tree.cleanup;
    const { apps } = detect(tree.root);
    const web = apps.find((a) => a.name === "web");
    const api = apps.find((a) => a.name === "api");

    // App-level + root-level env files.
    expect(web?.secrets).toContain("DATABASE_URL");
    expect(web?.secrets).toContain("SENTRY_DSN");
    // From a process.env.* source reference.
    expect(api?.secrets).toContain("API_KEY");
  });

  it("returns no apps for a bare monorepo", () => {
    const tree = writeTree({
      files: { "turbo.json": "{}", "package.json": JSON.stringify({ name: "root" }) },
    });
    cleanup = tree.cleanup;
    const result = detect(tree.root);
    expect(result.apps).toEqual([]);
  });
});

const NX_MONOREPO = {
  "nx.json": "{}",
  ".nvmrc": "20\n",
  ".env.example": "SENTRY_DSN=\n",
  "package.json": JSON.stringify({
    name: "root",
    packageManager: "pnpm@9.0.0",
    devDependencies: { nx: "19", "@nx/next": "19", "@nx/esbuild": "19" },
  }),
  "apps/web/project.json": JSON.stringify({
    name: "web",
    projectType: "application",
    targets: { build: { executor: "@nx/next:build" } },
  }),
  "apps/api/project.json": JSON.stringify({
    name: "api",
    projectType: "application",
    targets: { build: { executor: "@nx/esbuild:esbuild" } },
    implicitDependencies: ["shared"],
  }),
  "apps/api/src/main.ts": "const k = process.env.API_KEY;\n",
  "libs/shared/project.json": JSON.stringify({
    name: "shared",
    projectType: "library",
    targets: { build: { executor: "@nx/js:tsc" } },
  }),
};

describe("detect (Nx)", () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it("detects Nx apps and libs via project.json", () => {
    const tree = writeTree({ files: NX_MONOREPO });
    cleanup = tree.cleanup;
    const result = detect(tree.root);

    expect(result.tool).toBe("nx");
    expect(result.apps.map((a) => a.name)).toEqual(["api", "web"]);
    expect(result.libs.map((l) => l.name)).toEqual(["shared"]);
  });

  it("infers framework from the build executor", () => {
    const tree = writeTree({ files: NX_MONOREPO });
    cleanup = tree.cleanup;
    const { apps } = detect(tree.root);
    expect(apps.find((a) => a.name === "web")?.framework).toBe("next");
    expect(apps.find((a) => a.name === "api")?.framework).toBe("node-server");
  });

  it("uses the Nx project name and implicit deps", () => {
    const tree = writeTree({ files: NX_MONOREPO });
    cleanup = tree.cleanup;
    const api = detect(tree.root).apps.find((a) => a.name === "api");
    expect(api?.packageName).toBe("api"); // `nx build api`
    expect(api?.internalDeps).toEqual(["shared"]);
    expect(api?.watchPaths).toContain("libs/shared/**");
    expect(api?.watchPaths).toContain("nx.json");
    expect(api?.secrets).toContain("API_KEY");
    expect(api?.secrets).toContain("SENTRY_DSN");
  });
});
