import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface OwnPackageJson {
  name: string;
  version: string;
}

/**
 * deploykit's own package.json (name + version), found by walking up from this
 * module. Works from `src/` in dev (tsx/vitest) and from the bundled `dist/`
 * when installed — the nearest package.json above either is always our own.
 * Falls back to safe constants if the manifest can't be read.
 */
function readOwnPackageJson(): OwnPackageJson {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf8"),
      ) as Partial<OwnPackageJson>;
      if (pkg.name && pkg.version) return { name: pkg.name, version: pkg.version };
    } catch {
      /* keep walking up */
    }
    dir = dirname(dir);
  }
  return { name: "@alminabrulic/deploykit", version: "0.0.0" };
}

export const PKG = readOwnPackageJson();
