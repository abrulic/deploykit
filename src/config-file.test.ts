import { describe, expect, it } from "vitest";
import { CONFIG_FILE, loadConfigFile } from "./config-file.js";
import { generateConfigFile } from "./generate/configfile.js";
import { sampleConfig, writeTree } from "./testing/fixtures.js";

describe("loadConfigFile", () => {
  it("round-trips what generateConfigFile emits", () => {
    const tree = writeTree({
      files: { [CONFIG_FILE]: generateConfigFile(sampleConfig) },
    });
    try {
      const res = loadConfigFile(tree.root);
      expect(res.error).toBeUndefined();
      expect(res.config).toEqual(sampleConfig);
    } finally {
      tree.cleanup();
    }
  });

  it("tolerates hand-added comments and trailing commas", () => {
    const edited = `import { defineConfig } from "@alminabrulic/deploykit";
export default defineConfig({
  // bumped for the new runtime
  "tool": "turbo",
  "packageManager": "pnpm",
  /* our default */
  "nodeVersion": "22",
  "provider": { "type": "fly", "org": "acme", "region": "iad" },
  "apps": {},
});
`;
    const tree = writeTree({ files: { [CONFIG_FILE]: edited } });
    try {
      const res = loadConfigFile(tree.root);
      expect(res.error).toBeUndefined();
      expect(res.config?.nodeVersion).toBe("22");
    } finally {
      tree.cleanup();
    }
  });

  it("errors clearly when the file is missing", () => {
    const tree = writeTree({ files: {} });
    try {
      const res = loadConfigFile(tree.root);
      expect(res.error).toContain("deploykit init");
    } finally {
      tree.cleanup();
    }
  });

  it("errors on expressions instead of guessing", () => {
    const tree = writeTree({
      files: {
        [CONFIG_FILE]: `import { defineConfig } from "x";
const region = "iad";
export default defineConfig({ tool: "turbo", provider: { region } });
`,
      },
    });
    try {
      const { error } = loadConfigFile(tree.root);
      expect(error).toContain("no variables");
      expect(error).toContain(CONFIG_FILE);
    } finally {
      tree.cleanup();
    }
  });

  it("reads a config a formatter rewrote (bare keys, single quotes)", () => {
    // What Biome/Prettier leave behind in the user's repo after a commit hook
    // runs over the file deploykit generated — it must still load.
    const formatted = `import { defineConfig } from '@alminabrulic/deploykit';

export default defineConfig({
  tool: 'turbo',
  packageManager: 'pnpm',
  nodeVersion: '20',
  provider: { type: 'fly', org: 'acme', region: 'iad' },
  apps: {
    web: {
      root: 'apps/web',
      packageName: '@acme/web',
      framework: 'next',
      port: 3000,
      internalDeps: [],
      watchPaths: ['apps/web/**'],
      environments: { staging: { name: 'web-staging', trigger: 'push:main' } },
      secrets: ['DATABASE_URL'],
    },
  },
});
`;
    const tree = writeTree({ files: { [CONFIG_FILE]: formatted } });
    try {
      const res = loadConfigFile(tree.root);
      expect(res.error).toBeUndefined();
      expect(res.config?.apps.web?.environments.staging?.name).toBe(
        "web-staging",
      );
      expect(res.config?.apps.web?.secrets).toEqual(["DATABASE_URL"]);
    } finally {
      tree.cleanup();
    }
  });

  it("errors when required fields are missing", () => {
    const tree = writeTree({
      files: {
        [CONFIG_FILE]: `import { defineConfig } from "x";
export default defineConfig({ "tool": "turbo" });
`,
      },
    });
    try {
      expect(loadConfigFile(tree.root).error).toContain("required fields");
    } finally {
      tree.cleanup();
    }
  });

  it("keeps values containing // intact (only whole-line comments stripped)", () => {
    const withUrl = `import { defineConfig } from "x";
export default defineConfig({
  "tool": "turbo",
  "packageManager": "pnpm",
  "nodeVersion": "20",
  "provider": { "type": "fly", "org": "acme", "region": "iad" },
  "apps": { "web": { "root": "apps/web", "secrets": [], "environments": {},
    "watchPaths": ["https://irrelevant.example/x//y"] } }
});
`;
    const tree = writeTree({ files: { [CONFIG_FILE]: withUrl } });
    try {
      const res = loadConfigFile(tree.root);
      expect(res.error).toBeUndefined();
      expect(res.config?.apps.web?.watchPaths).toEqual([
        "https://irrelevant.example/x//y",
      ]);
    } finally {
      tree.cleanup();
    }
  });
});
