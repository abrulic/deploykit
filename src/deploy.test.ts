import { describe, expect, it, vi } from "vitest";
import type { AppConfig, DeploykitConfig } from "./config.js";
import {
  type DeployDeps,
  deployArgs,
  deployTargets,
  firstDeploy,
  flyUrl,
} from "./deploy.js";

/** A minimal app config with overridable fields. */
function app(over: Partial<AppConfig> = {}): AppConfig {
  return {
    root: "apps/web",
    packageName: "web",
    framework: "node-server",
    serve: "server",
    port: 3000,
    internalDeps: [],
    watchPaths: [],
    environments: {},
    secrets: [],
    ...over,
  };
}

function config(apps: Record<string, AppConfig>): DeploykitConfig {
  return {
    tool: "turbo",
    packageManager: "pnpm",
    nodeVersion: "20",
    provider: { type: "fly", org: "acme", region: "iad" },
    apps,
  };
}

describe("deployArgs", () => {
  it("mirrors the workflow deploy step (context, config, dockerfile, app, flags)", () => {
    const args = deployArgs({
      app: "web",
      flyApp: "acme-web-staging",
      root: "apps/web",
      secrets: [],
      buildArgs: [],
    });
    expect(args).toEqual([
      "deploy",
      ".",
      "--config",
      "apps/web/fly.toml",
      "--dockerfile",
      "apps/web/Dockerfile",
      "--app",
      "acme-web-staging",
      "--remote-only",
      "--ha=false",
    ]);
  });

  it("forwards each build-time var as a --build-arg", () => {
    const args = deployArgs({
      app: "web",
      flyApp: "acme-web-staging",
      root: "apps/web",
      secrets: [],
      buildArgs: [
        { name: "NEXT_PUBLIC_URL", value: "https://x.dev" },
        { name: "SENTRY_DSN", value: "abc" },
      ],
    });
    expect(args).toContain("--build-arg");
    expect(args.slice(-4)).toEqual([
      "--build-arg",
      "NEXT_PUBLIC_URL=https://x.dev",
      "--build-arg",
      "SENTRY_DSN=abc",
    ]);
  });
});

describe("deployTargets", () => {
  it("includes only apps with a staging environment", () => {
    const cfg = config({
      web: app({
        environments: {
          staging: { name: "acme-web-staging", trigger: "push:main" },
        },
      }),
      docs: app({
        environments: { preview: { name: "acme-docs-pr-{pr}", trigger: "pr" } },
      }),
    });
    const targets = deployTargets({ config: cfg, captured: [] });
    expect(targets.map((t) => t.app)).toEqual(["web"]);
    expect(targets[0]?.flyApp).toBe("acme-web-staging");
  });

  it("takes only the values each app declares, split into secrets vs build-args", () => {
    const cfg = config({
      web: app({
        secrets: ["DATABASE_URL"],
        buildEnv: ["NEXT_PUBLIC_URL"],
        environments: {
          staging: { name: "acme-web-staging", trigger: "push:main" },
        },
      }),
    });
    const captured = [
      { name: "DATABASE_URL", value: "postgres://x" },
      { name: "NEXT_PUBLIC_URL", value: "https://x.dev" },
      { name: "UNRELATED", value: "nope" },
    ];
    const [t] = deployTargets({ config: cfg, captured });
    expect(t?.secrets).toEqual([
      { name: "DATABASE_URL", value: "postgres://x" },
    ]);
    expect(t?.buildArgs).toEqual([
      { name: "NEXT_PUBLIC_URL", value: "https://x.dev" },
    ]);
  });

  it("skips declared secrets that weren't captured (no value to stage)", () => {
    const cfg = config({
      web: app({
        secrets: ["DATABASE_URL", "API_KEY"],
        environments: {
          staging: { name: "acme-web-staging", trigger: "push:main" },
        },
      }),
    });
    const [t] = deployTargets({
      config: cfg,
      captured: [{ name: "API_KEY", value: "k" }],
    });
    expect(t?.secrets).toEqual([{ name: "API_KEY", value: "k" }]);
  });

  it("carries the staging hostname through when configured", () => {
    const cfg = config({
      web: app({
        environments: {
          staging: {
            name: "acme-web-staging",
            trigger: "push:main",
            hostname: "staging.acme.dev",
          },
        },
      }),
    });
    expect(deployTargets({ config: cfg, captured: [] })[0]?.hostname).toBe(
      "staging.acme.dev",
    );
  });
});

describe("flyUrl", () => {
  it("builds the immediate .fly.dev URL", () => {
    expect(flyUrl("acme-web-staging")).toBe("https://acme-web-staging.fly.dev");
  });
});

const stagingCfg = () =>
  config({
    web: app({
      secrets: ["DATABASE_URL"],
      environments: {
        staging: { name: "acme-web-staging", trigger: "push:main" },
      },
    }),
  });

function deps(over: Partial<DeployDeps> = {}) {
  const warn = vi.fn();
  const success = vi.fn();
  const info = vi.fn();
  const step = vi.fn();
  const base: DeployDeps = {
    confirm: vi.fn(async () => true),
    stageSecret: vi.fn(async () => true),
    runDeploy: vi.fn(async () => 0),
    log: { warn, success, info, step },
    ...over,
  };
  return { d: base, warn, success, info, step };
}

describe("firstDeploy", () => {
  it("does nothing when no app has a staging environment", async () => {
    const { d } = deps();
    const cfg = config({
      web: app({
        environments: { preview: { name: "x-pr-{pr}", trigger: "pr" } },
      }),
    });
    await firstDeploy({ config: cfg, cwd: ".", flyReady: true, deps: d });
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.runDeploy).not.toHaveBeenCalled();
  });

  it("warns and skips when flyctl isn't authenticated", async () => {
    const { d, warn } = deps();
    await firstDeploy({
      config: stagingCfg(),
      cwd: ".",
      flyReady: false,
      deps: d,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("flyctl isn't authenticated"),
    );
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.runDeploy).not.toHaveBeenCalled();
  });

  it("skips the deploy when the user declines the confirm", async () => {
    const { d, info } = deps({ confirm: vi.fn(async () => false) });
    await firstDeploy({
      config: stagingCfg(),
      cwd: ".",
      flyReady: true,
      deps: d,
    });
    expect(d.runDeploy).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("Skipping first deploy"),
    );
  });

  it("stages captured secrets, then deploys, and reports the URL", async () => {
    const { d, success } = deps();
    await firstDeploy({
      config: stagingCfg(),
      cwd: "/repo",
      flyReady: true,
      captured: [{ name: "DATABASE_URL", value: "postgres://x" }],
      deps: d,
    });
    expect(d.stageSecret).toHaveBeenCalledWith(
      "acme-web-staging",
      { name: "DATABASE_URL", value: "postgres://x" },
      "/repo",
    );
    expect(d.runDeploy).toHaveBeenCalledWith(
      expect.arrayContaining(["deploy", "--app", "acme-web-staging"]),
      "/repo",
    );
    expect(success).toHaveBeenCalledWith(
      expect.stringContaining("https://acme-web-staging.fly.dev"),
    );
  });

  it("skips the confirm under assumeYes", async () => {
    const { d } = deps();
    await firstDeploy({
      config: stagingCfg(),
      cwd: ".",
      flyReady: true,
      assumeYes: true,
      deps: d,
    });
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.runDeploy).toHaveBeenCalled();
  });

  it("warns (doesn't throw) when a deploy exits non-zero", async () => {
    const { d, warn, success } = deps({ runDeploy: vi.fn(async () => 1) });
    await firstDeploy({
      config: stagingCfg(),
      cwd: ".",
      flyReady: true,
      assumeYes: true,
      deps: d,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("didn't finish"));
    expect(success).not.toHaveBeenCalled();
  });
});
