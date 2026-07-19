import { afterEach, describe, expect, it } from "vitest";
import { detect, detectFramework } from "./detect.js";
import { writeTree } from "./testing/fixtures.js";

describe("detectFramework", () => {
  it("maps known deps to frameworks", () => {
    expect(detectFramework({ dependencies: { next: "14" } })).toBe("next");
    expect(detectFramework({ dependencies: { "@remix-run/node": "2" } })).toBe(
      "remix",
    );
    expect(detectFramework({ dependencies: { astro: "4" } })).toBe("astro");
    expect(detectFramework({ dependencies: { fastify: "4" } })).toBe(
      "node-server",
    );
    expect(detectFramework({ dependencies: { express: "4" } })).toBe(
      "node-server",
    );
    expect(detectFramework({ devDependencies: { vite: "5" } })).toBe("vite");
  });

  it("detects React Router 7 framework mode via @react-router/dev", () => {
    expect(
      detectFramework({
        dependencies: { "react-router": "7", "@react-router/serve": "7" },
        devDependencies: { "@react-router/dev": "7", vite: "6" },
      }),
    ).toBe("react-router");
  });

  it("treats a plain SPA that only routes with react-router as vite", () => {
    // `react-router` for client routing, but no framework dev plugin.
    expect(
      detectFramework({
        dependencies: { "react-router": "7" },
        devDependencies: { vite: "6" },
      }),
    ).toBe("vite");
  });

  it("prefers next over a bundled vite", () => {
    expect(
      detectFramework({
        dependencies: { next: "14" },
        devDependencies: { vite: "5" },
      }),
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
  "package.json": JSON.stringify({
    name: "root",
    packageManager: "pnpm@9.0.0",
  }),
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

  it("finds env vars read inside internal workspace deps", () => {
    const tree = writeTree({
      files: {
        ...MONOREPO,
        // web depends on @acme/ui; a var read there belongs to web's closure.
        "packages/ui/src/theme.ts": "const k = process.env.SHARED_KEY;\n",
      },
    });
    cleanup = tree.cleanup;
    const web = detect(tree.root).apps.find((a) => a.name === "web");
    expect(web?.secrets).toContain("SHARED_KEY");
    // api does not depend on @acme/ui — no bleed-through.
    const api = detect(tree.root).apps.find((a) => a.name === "api");
    expect(api?.secrets).not.toContain("SHARED_KEY");
  });

  it("classifies client-exposed prefixes as build-time for server apps", () => {
    const tree = writeTree({
      files: {
        ...MONOREPO,
        "apps/web/src/env.ts":
          "export const url = process.env.NEXT_PUBLIC_API_URL;\n",
      },
    });
    cleanup = tree.cleanup;
    const web = detect(tree.root).apps.find((a) => a.name === "web");
    expect(web?.buildEnv).toContain("NEXT_PUBLIC_API_URL");
    expect(web?.secrets).not.toContain("NEXT_PUBLIC_API_URL");
    // Runtime vars stay runtime.
    expect(web?.secrets).toContain("DATABASE_URL");
  });

  it("treats every var of a static app as build-time (import.meta.env too)", () => {
    const tree = writeTree({
      files: {
        ...MONOREPO,
        "apps/spa/package.json": JSON.stringify({
          name: "@acme/spa",
          devDependencies: { vite: "5" },
        }),
        "apps/spa/src/main.ts":
          "const a = import.meta.env.VITE_API_URL; const b = import.meta.env.APP_MODE;\n",
      },
    });
    cleanup = tree.cleanup;
    const spa = detect(tree.root).apps.find((a) => a.name === "spa");
    expect(spa?.serve).toBe("static");
    // No runtime process → nothing can be a runtime secret.
    expect(spa?.buildEnv).toEqual(
      expect.arrayContaining(["VITE_API_URL", "APP_MODE"]),
    );
    expect(spa?.secrets).toEqual([]);
  });

  it("returns no apps for a bare monorepo", () => {
    const tree = writeTree({
      files: {
        "turbo.json": "{}",
        "package.json": JSON.stringify({ name: "root" }),
      },
    });
    cleanup = tree.cleanup;
    const result = detect(tree.root);
    expect(result.apps).toEqual([]);
  });

  it("throws when neither turbo.json nor nx.json exists", () => {
    const tree = writeTree({
      files: { "package.json": JSON.stringify({ name: "root" }) },
    });
    cleanup = tree.cleanup;
    // Must not silently fall back to "nx" — detect() is a public entry point.
    expect(() => detect(tree.root)).toThrow(/turbo\.json \/ nx\.json/);
  });

  it("warns when a Next app's config lacks output standalone", () => {
    const tree = writeTree({ files: MONOREPO });
    cleanup = tree.cleanup;
    // MONOREPO's web app has no next.config at all.
    const { warnings } = detect(tree.root);
    expect(
      warnings.some((w) => w.includes("standalone") && w.includes("web")),
    ).toBe(true);
  });

  it("stays quiet when the Next config sets output standalone", () => {
    const tree = writeTree({
      files: {
        ...MONOREPO,
        "apps/web/next.config.mjs":
          'export default { output: "standalone" };\n',
      },
    });
    cleanup = tree.cleanup;
    expect(detect(tree.root).warnings).toEqual([]);
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

// A package-based Nx repo (nx.json but no project.json) mirroring the real
// React Router 7 + Prisma + lefthook monorepo that motivated this detection.
const RR7_MONOREPO = {
  "nx.json": "{}",
  "pnpm-workspace.yaml": "packages:\n  - 'test-apps/*'\n  - 'packages/*'\n",
  "package.json": JSON.stringify({
    name: "root",
    packageManager: "pnpm@10.8.0",
    engines: { node: ">=20.0.0" },
    scripts: { prepare: "lefthook install" },
    devDependencies: { lefthook: "^1.11.10" },
  }),
  "test-apps/storefront-app/package.json": JSON.stringify({
    name: "storefront-app",
    engines: { node: ">=22.0.0" },
    scripts: {
      build: "react-router build",
      start: "react-router-serve ./build/server/index.js",
    },
    dependencies: {
      "react-router": "^7.5.0",
      "@react-router/node": "^7.5.0",
      "@react-router/serve": "^7.5.0",
      "@ecommerce/database": "workspace:*",
    },
    devDependencies: { "@react-router/dev": "^7.5.0", vite: "^6.2.6" },
  }),
  "packages/database/package.json": JSON.stringify({
    name: "@ecommerce/database",
    dependencies: { "@prisma/client": "^7.7.0", prisma: "^7.7.0" },
  }),
  "packages/database/prisma.config.ts": "export default {}\n",
  "packages/database/prisma/schema.prisma": "// schema\n",
};

describe("detect (React Router 7 / package-based Nx)", () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  const run = () => {
    const tree = writeTree({ files: RR7_MONOREPO });
    cleanup = tree.cleanup;
    return detect(tree.root);
  };

  it("classifies the RR7 app as a server, package-based", () => {
    const result = run();
    const app = result.apps.find((a) => a.name === "storefront-app");
    expect(result.tool).toBe("nx");
    expect(result.nxIntegrated).toBe(false);
    expect(app?.framework).toBe("react-router");
    expect(app?.serve).toBe("server");
    // A direct `node` command runs react-router-serve's bin, so the runner
    // needs no package manager (a bare node image has none).
    expect(app?.startCommand).toEqual([
      "node",
      "node_modules/@react-router/serve/bin.js",
      "./build/server/index.js",
    ]);
  });

  it("resolves the Node version from the app's engines, not just the root", () => {
    expect(run().nodeVersion).toBe("22");
  });

  it("neutralizes the lefthook prepare hook via install env", () => {
    expect(run().installEnv).toEqual({ LEFTHOOK: "0" });
  });

  it("assigns the Prisma package to the app that depends on it", () => {
    const app = run().apps.find((a) => a.name === "storefront-app");
    expect(app?.prisma).toEqual([
      {
        packageName: "@ecommerce/database",
        root: "packages/database",
        schema: "prisma/schema.prisma",
        hasConfig: true,
      },
    ]);
  });
});

describe("detect — serve model & install env variants", () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it("detects a React Router 7 SPA (ssr:false) as static", () => {
    const tree = writeTree({
      files: {
        "turbo.json": "{}",
        "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
        "package.json": JSON.stringify({
          name: "root",
          packageManager: "pnpm@10",
        }),
        "apps/spa/package.json": JSON.stringify({
          name: "@acme/spa",
          scripts: { build: "react-router build" },
          devDependencies: { "@react-router/dev": "7", vite: "6" },
        }),
        "apps/spa/react-router.config.ts": "export default { ssr: false }\n",
      },
    });
    cleanup = tree.cleanup;
    const app = detect(tree.root).apps.find((a) => a.name === "spa");
    expect(app?.serve).toBe("static");
    expect(app?.outputDir).toBe("apps/spa/build/client");
    expect(app?.spa).toBe(true);
  });

  it("detects a husky prepare hook", () => {
    const tree = writeTree({
      files: {
        "turbo.json": "{}",
        "package.json": JSON.stringify({
          name: "root",
          scripts: { prepare: "husky" },
        }),
      },
    });
    cleanup = tree.cleanup;
    expect(detect(tree.root).installEnv).toEqual({ HUSKY: "0" });
  });
});
