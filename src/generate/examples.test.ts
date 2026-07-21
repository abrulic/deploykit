import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfigFile } from "../config-file.js";
import { planFiles } from "./index.js";

/**
 * `examples/` is published in the README as the byte-for-byte output deploykit
 * produces for a two-app Turbo monorepo. It drifted once already, so assert it
 * rather than trusting a habit: regenerate from its own config and require every
 * file to come back identical.
 *
 * When this fails after an intentional generator change, refresh the fixtures:
 *   pnpm dev generate --cwd examples --yes
 */
const EXAMPLES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../examples",
);

describe("examples/", () => {
  it("is exactly what the generators emit today", () => {
    const loaded = loadConfigFile(EXAMPLES);
    expect(loaded.error).toBeUndefined();
    if (!loaded.config) return;

    const files = planFiles({ config: loaded.config, cwd: EXAMPLES });
    expect(files.length).toBeGreaterThan(0);

    const stale = files
      .filter((f) => f.status !== "identical")
      .map((f) => `${f.path} (${f.status})`);
    expect(stale).toEqual([]);
  });
});
