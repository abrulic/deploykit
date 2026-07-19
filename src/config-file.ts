import { join } from "node:path";
import type { DeploykitConfig } from "./config.js";
import { readText } from "./util/fsx.js";

/** Workspace-relative path of the config file `init` writes and `generate` reads. */
export const CONFIG_FILE = "deploykit.config.ts";

export type LoadConfigResult =
  | { config: DeploykitConfig; error?: undefined }
  | { config?: undefined; error: string };

/**
 * Load `deploykit.config.ts` so `deploykit generate` can regenerate every
 * output from it — this is what makes the config an actual source of truth.
 *
 * The file is TS for editor types, but its payload is a JSON object literal
 * (that's what `init` emits). We extract the `defineConfig(...)` argument and
 * parse it, tolerating the light edits people make by hand: `//` line
 * comments, block comments, and trailing commas. Anything beyond that (spread,
 * identifiers, template strings) fails with a clear message rather than
 * guessing.
 */
export function loadConfigFile(cwd: string): LoadConfigResult {
  const text = readText(join(cwd, CONFIG_FILE));
  if (text === null) {
    return {
      error: `${CONFIG_FILE} not found — run \`deploykit init\` first.`,
    };
  }

  const m = text.match(/defineConfig\s*\(([\s\S]*)\)/);
  if (!m?.[1]) {
    return {
      error: `couldn't find a defineConfig(...) call in ${CONFIG_FILE}.`,
    };
  }

  const cleaned = m[1]
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/^\s*\/\/.*$/gm, "") // whole-line comments (values with // stay intact)
    .replace(/,\s*([}\]])/g, "$1"); // trailing commas

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      error:
        `couldn't parse the object passed to defineConfig in ${CONFIG_FILE} — ` +
        "keep it JSON-style (double-quoted keys and strings, no expressions).",
    };
  }

  if (!isDeploykitConfig(parsed)) {
    return {
      error: `${CONFIG_FILE} is missing required fields (tool, packageManager, apps).`,
    };
  }
  return { config: parsed };
}

/** Narrow parsed JSON to a config with the required top-level fields present. */
function isDeploykitConfig(value: unknown): value is DeploykitConfig {
  if (typeof value !== "object" || value === null) return false;
  return (
    "tool" in value &&
    Boolean(value.tool) &&
    "packageManager" in value &&
    Boolean(value.packageManager) &&
    "apps" in value &&
    typeof value.apps === "object" &&
    value.apps !== null
  );
}
