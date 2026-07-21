import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // deploykit's own tests live under src/. The docs/ subproject is a
    // self-contained app with its own test runner (browser + React), so keep
    // the root suite from picking up its *.test.ts files.
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "dist/**", "docs/**"],
  },
});
