import { defineConfig } from "tsup";

export default defineConfig([
  {
    // The CLI. Runs first, so it owns `clean`.
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "node20",
    clean: true,
    minify: false,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    // The library entries, built together so their shared internals land in one
    // chunk instead of being duplicated into each file.
    //
    // `config` is load-bearing, not a nicety: every generated
    // `deploykit.config.ts` starts with `import { defineConfig } from
    // "@alminabrulic/deploykit"`, and without this build (plus the matching
    // "exports" in package.json) that import resolves to nothing — the user's
    // config then fails to typecheck. `dts` is what types it in their editor,
    // which is the whole reason the config is TypeScript rather than JSON.
    //
    // `generate` exposes the pure generators for callers building on top of
    // deploykit. Keep these entries pure: no prompts, no interactive stdio.
    entry: {
      config: "src/config.ts",
      generate: "src/generate/index.ts",
    },
    format: ["esm"],
    target: "node20",
    dts: true,
    minify: false,
  },
]);
