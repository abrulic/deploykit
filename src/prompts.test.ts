import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { DetectedApp, Detection } from "./detect.js";
import {
  buildConfig,
  defaultNamePrefix,
  type InitOptions,
  sanitizeFlyName,
} from "./prompts.js";
import { writeTree } from "./testing/fixtures.js";

const app: DetectedApp = {
  name: "web",
  root: "apps/web",
  packageName: "@acme/web",
  framework: "next",
  serve: "server",
  deployable: true,
  port: 3000,
  internalDeps: ["@acme/ui"],
  watchPaths: ["apps/web/**", "packages/ui/**"],
  secrets: ["DATABASE_URL"],
  buildEnv: ["NEXT_PUBLIC_API_URL"],
  hasDockerfile: false,
  hasFlyToml: false,
};

const detection: Detection = {
  tool: "turbo",
  packageManager: "pnpm",
  nodeVersion: "20",
  apps: [app],
  libs: [],
  hasExistingWorkflows: false,
  warnings: [],
};

// A fixture repo root: its package.json name drives the default Fly name prefix.
const tree = writeTree({
  files: { "package.json": JSON.stringify({ name: "@acme/shop_Monorepo" }) },
});

const baseOpts: InitOptions = {
  yes: true,
  dryRun: false,
  provision: false,
  pr: false,
  force: false,
  cwd: tree.root,
};

describe("buildConfig (non-interactive)", () => {
  const savedOrg = process.env.FLY_ORG;
  beforeEach(() => {
    delete process.env.FLY_ORG;
  });
  afterEach(() => {
    if (savedOrg === undefined) delete process.env.FLY_ORG;
    else process.env.FLY_ORG = savedOrg;
    vi.restoreAllMocks();
  });
  afterAll(() => tree.cleanup());

  it("builds a config from detection and flags", async () => {
    const config = await buildConfig({
      detection,
      opts: { ...baseOpts, org: "acme", region: "sjc" },
    });
    expect(config).not.toBeNull();
    expect(config?.provider).toEqual({
      type: "fly",
      org: "acme",
      region: "sjc",
    });
    expect(Object.keys(config?.apps ?? {})).toEqual(["web"]);
    // Fly names are globally unique → every name carries the derived prefix.
    expect(config?.namePrefix).toBe("shop-monorepo");
    expect(config?.apps.web?.environments).toMatchObject({
      preview: { name: "shop-monorepo-web-pr-{pr}" },
      staging: { name: "shop-monorepo-web-staging" },
      production: { name: "shop-monorepo-web-prod" },
    });
  });

  it("honors --envs in non-interactive mode instead of enabling all three", async () => {
    const config = await buildConfig({
      detection,
      opts: { ...baseOpts, org: "acme", envs: ["staging"] },
    });
    expect(Object.keys(config?.apps.web?.environments ?? {})).toEqual([
      "staging",
    ]);
  });

  it("defaults the region to iad when not provided", async () => {
    const config = await buildConfig({
      detection,
      opts: { ...baseOpts, org: "acme" },
    });
    expect(config?.provider.region).toBe("iad");
  });

  it("reads the org from FLY_ORG when the flag is absent", async () => {
    process.env.FLY_ORG = "envorg";
    const config = await buildConfig({ detection, opts: baseOpts });
    expect(config?.provider.org).toBe("envorg");
  });

  it("returns null when no org can be resolved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const config = await buildConfig({ detection, opts: baseOpts });
    expect(config).toBeNull();
  });

  it("threads serve model, prisma, install-env and nxIntegrated into the config", async () => {
    const ssrApp: DetectedApp = {
      ...app,
      framework: "react-router",
      serve: "server",
      prisma: [
        {
          packageName: "@acme/db",
          root: "packages/db",
          schema: "prisma/schema.prisma",
          hasConfig: true,
        },
      ],
    };
    const nxDetection: Detection = {
      ...detection,
      tool: "nx",
      nxIntegrated: false,
      installEnv: { LEFTHOOK: "0" },
      apps: [ssrApp],
    };
    const config = await buildConfig({
      detection: nxDetection,
      opts: { ...baseOpts, org: "acme" },
    });
    expect(config?.installEnv).toEqual({ LEFTHOOK: "0" });
    expect(config?.nxIntegrated).toBe(false);
    expect(config?.apps.web?.serve).toBe("server");
    expect(config?.apps.web?.prisma).toHaveLength(1);
  });

  it("omits runner-shaping fields when they carry no information", async () => {
    const config = await buildConfig({
      detection,
      opts: { ...baseOpts, org: "acme" },
    });
    // A plain turbo repo: no install-env, no nxIntegrated, no prisma on the app.
    expect(config?.installEnv).toBeUndefined();
    expect(config?.nxIntegrated).toBeUndefined();
    expect(config?.apps.web).not.toHaveProperty("prisma");
    expect(config?.apps.web).not.toHaveProperty("startCommand");
  });

  it("persists build-time env vars separately from runtime secrets", async () => {
    const config = await buildConfig({
      detection,
      opts: { ...baseOpts, org: "acme" },
    });
    expect(config?.apps.web?.secrets).toEqual(["DATABASE_URL"]);
    expect(config?.apps.web?.buildEnv).toEqual(["NEXT_PUBLIC_API_URL"]);
  });
});

describe("name prefix derivation", () => {
  it("sanitizes into a valid Fly name fragment", () => {
    expect(sanitizeFlyName("@acme/Shop_Monorepo")).toBe("shop-monorepo");
    expect(sanitizeFlyName("My Cool App!!")).toBe("my-cool-app");
    expect(sanitizeFlyName("--weird--")).toBe("weird");
    expect(sanitizeFlyName("x".repeat(50))).toHaveLength(30);
  });

  it("falls back to the directory name when there's no package name", () => {
    const bare = writeTree({ files: { "turbo.json": "{}" } });
    try {
      // mkdtemp dirs look like "deploykit-test-XXXXXX" — already a valid slug.
      expect(defaultNamePrefix(bare.root)).toMatch(/^deploykit-test-/);
    } finally {
      bare.cleanup();
    }
  });
});
