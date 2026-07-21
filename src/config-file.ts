import { join } from "node:path";
import type { DeploykitConfig } from "./config.js";
import { parseObjectLiteral } from "./config-literal.js";
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
 * The file is TS for editor types, but its payload is an object literal (that's
 * what `init` emits). We locate the `defineConfig(...)` call and read its
 * argument as data — never executing the file. `parseObjectLiteral` accepts the
 * whole hand-edited/formatter-rewritten range: quoted or bare keys, either
 * quote style, comments, trailing commas. Anything needing evaluation (a
 * variable, spread, or call) fails with a message naming the line.
 */
export function loadConfigFile(cwd: string): LoadConfigResult {
  const text = readText(join(cwd, CONFIG_FILE));
  if (text === null) {
    return {
      error: `${CONFIG_FILE} not found — run \`deploykit init\` first.`,
    };
  }

  const call = /defineConfig\s*\(/.exec(text);
  if (!call) {
    return {
      error: `couldn't find a defineConfig(...) call in ${CONFIG_FILE}.`,
    };
  }

  const { value: parsed, error } = parseObjectLiteral({
    source: text,
    from: call.index + call[0].length,
  });
  if (error !== undefined) {
    return {
      error:
        `couldn't read the object passed to defineConfig in ${CONFIG_FILE}: ${error}. ` +
        "It holds plain data only — no variables, imports or expressions.",
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
