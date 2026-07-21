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
    // The library entry. Every generated `deploykit.config.ts` starts with
    // `import { defineConfig } from "@alminabrulic/deploykit"` — without this
    // build (and the matching "exports" in package.json) that import resolves
    // to nothing, so the user's config fails to typecheck and can't be loaded
    // by their own tooling. `dts` is what makes the config typed in an editor,
    // which is the whole reason the config is TypeScript rather than JSON.
    entry: ["src/config.ts"],
    format: ["esm"],
    target: "node20",
    dts: true,
    minify: false,
  },
]);
