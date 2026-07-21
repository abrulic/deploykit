import { describe, expect, it } from "vitest";
import { generateConfigFile } from "../generate/configfile.js";
import type { InitOptions } from "../prompts.js";
import { sampleConfig, writeTree } from "../testing/fixtures.js";
import {
  parseReleases,
  type RollbackDeps,
  rollbackCandidates,
  rollbackDeployArgs,
  runRollback,
} from "./rollback.js";

describe("parseReleases", () => {
  it("normalizes camelCase, snake_case and PascalCase keys", () => {
    const camel = parseReleases(
      JSON.stringify([{ version: 5, status: "complete", imageRef: "img:5" }]),
    );
    const snake = parseReleases(
      JSON.stringify([{ version: 5, status: "complete", image_ref: "img:5" }]),
    );
    const pascal = parseReleases(
      JSON.stringify([{ Version: 5, Status: "complete", ImageRef: "img:5" }]),
    );
    for (const r of [camel, snake, pascal]) {
      expect(r).toHaveLength(1);
      expect(r[0]?.version).toBe(5);
      expect(r[0]?.image).toBe("img:5");
    }
  });

  it("drops entries without a numeric version and tolerates junk JSON", () => {
    expect(parseReleases("not json")).toEqual([]);
    expect(parseReleases(JSON.stringify({ not: "an array" }))).toEqual([]);
    expect(
      parseReleases(JSON.stringify([{ status: "complete" }, null, 3])),
    ).toEqual([]);
  });
});

describe("rollbackCandidates", () => {
  const releases = parseReleases(
    JSON.stringify([
      { version: 10, status: "complete", imageRef: "img:10" }, // current
      { version: 9, status: "complete", imageRef: "img:9" },
      { version: 8, status: "failed", imageRef: "" }, // no image
      { version: 7, status: "complete", imageRef: "img:7" },
    ]),
  );

  it("excludes the current release and any without an image, newest first", () => {
    const c = rollbackCandidates(releases);
    expect(c.map((r) => r.version)).toEqual([9, 7]);
  });

  it("returns nothing when there is only the current release", () => {
    expect(
      rollbackCandidates(
        parseReleases(JSON.stringify([{ version: 1, imageRef: "img:1" }])),
      ),
    ).toEqual([]);
  });
});

describe("rollbackDeployArgs", () => {
  it("redeploys the given image against the env's Fly app and repo fly.toml", () => {
    expect(
      rollbackDeployArgs({
        flyApp: "web-prod",
        root: "apps/web",
        image: "img:9",
      }),
    ).toEqual([
      "deploy",
      "--app",
      "web-prod",
      "--image",
      "img:9",
      "--config",
      "apps/web/fly.toml",
    ]);
  });
});

function baseOpts(cwd: string, over: Partial<InitOptions> = {}): InitOptions {
  return {
    yes: false,
    dryRun: false,
    provision: false,
    deploy: false,
    pr: false,
    force: false,
    cwd,
    ...over,
  };
}

/** A temp repo whose deploykit.config.ts is the sample config. */
function repoWithConfig() {
  const { root, cleanup } = writeTree({
    files: { "deploykit.config.ts": generateConfigFile(sampleConfig) },
  });
  return { root, cleanup };
}

const RELEASES = JSON.stringify([
  { version: 41, status: "complete", imageRef: "img:41" },
  { version: 40, status: "complete", imageRef: "img:40" },
  { version: 39, status: "complete", imageRef: "img:39" },
]);

function fakeDeps(over: Partial<RollbackDeps> = {}) {
  const calls: { deploy?: string[] } = {};
  const deps: RollbackDeps = {
    listReleases: async () => RELEASES,
    runDeploy: async (args) => {
      calls.deploy = args;
      return 0;
    },
    select: async () => null,
    confirm: async () => true,
    log: {
      info: () => {},
      warn: () => {},
      success: () => {},
      error: () => {},
      step: () => {},
    },
    ...over,
  };
  return { deps, calls };
}

describe("runRollback", () => {
  it("redeploys the chosen prior image for the target env", async () => {
    const { root, cleanup } = repoWithConfig();
    try {
      const { deps, calls } = fakeDeps();
      const code = await runRollback(
        baseOpts(root, { app: "web", env: "production", to: "40", yes: true }),
        deps,
      );
      expect(code).toBe(0);
      expect(calls.deploy).toEqual([
        "deploy",
        "--app",
        "web-prod",
        "--image",
        "img:40",
        "--config",
        "apps/web/fly.toml",
      ]);
    } finally {
      cleanup();
    }
  });

  it("fails non-interactively without an explicit --to", async () => {
    const { root, cleanup } = repoWithConfig();
    try {
      const { deps, calls } = fakeDeps();
      const code = await runRollback(
        baseOpts(root, { app: "web", env: "production", yes: true }),
        deps,
      );
      expect(code).toBe(1);
      expect(calls.deploy).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("rolls back the environment picked at the prompt", async () => {
    const { root, cleanup } = repoWithConfig();
    try {
      // `web` has staging + production, so the env is asked for first, then
      // the release.
      const answers = ["staging", "40"];
      const { deps, calls } = fakeDeps({
        select: async () => answers.shift() ?? null,
      });
      const code = await runRollback(baseOpts(root, { app: "web" }), deps);
      expect(code).toBe(0);
      expect(calls.deploy).toEqual([
        "deploy",
        "--app",
        "web-staging",
        "--image",
        "img:40",
        "--config",
        "apps/web/fly.toml",
      ]);
    } finally {
      cleanup();
    }
  });

  it("ignores an environment that wasn't among the offered options", async () => {
    const { root, cleanup } = repoWithConfig();
    try {
      // Previews aren't rollbackable, so a "preview" answer must not be taken
      // at face value just because it looks like an EnvironmentKind.
      const { deps, calls } = fakeDeps({ select: async () => "preview" });
      const code = await runRollback(baseOpts(root, { app: "web" }), deps);
      expect(code).toBe(1);
      expect(calls.deploy).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("rejects an unknown app", async () => {
    const { root, cleanup } = repoWithConfig();
    try {
      const { deps, calls } = fakeDeps();
      const code = await runRollback(
        baseOpts(root, { app: "nope", env: "production", yes: true }),
        deps,
      );
      expect(code).toBe(1);
      expect(calls.deploy).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("rejects an env the app doesn't have", async () => {
    const { root, cleanup } = repoWithConfig();
    try {
      // sampleConfig's `api` app only has staging.
      const { deps, calls } = fakeDeps();
      const code = await runRollback(
        baseOpts(root, { app: "api", env: "production", to: "40", yes: true }),
        deps,
      );
      expect(code).toBe(1);
      expect(calls.deploy).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("surfaces a flyctl deploy failure", async () => {
    const { root, cleanup } = repoWithConfig();
    try {
      const { deps } = fakeDeps({ runDeploy: async () => 1 });
      const code = await runRollback(
        baseOpts(root, { app: "web", env: "production", to: "40", yes: true }),
        deps,
      );
      expect(code).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("fails cleanly when there is no config file", async () => {
    const { root, cleanup } = writeTree({ files: { "README.md": "x" } });
    try {
      const { deps } = fakeDeps();
      const code = await runRollback(
        baseOpts(root, { app: "web", env: "production", to: "40", yes: true }),
        deps,
      );
      expect(code).toBe(1);
    } finally {
      cleanup();
    }
  });
});
