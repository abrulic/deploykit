import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DeploykitConfig } from "../config.js";
import { fileExists } from "../util/fsx.js";
import { generateConfigFile } from "./configfile.js";
import { generateDockerfile } from "./dockerfile.js";
import { generateDockerignore } from "./dockerignore.js";
import { generateFlyToml } from "./flytoml.js";
import { generateWorkflow } from "./workflow.js";

export interface GeneratedFile {
  /** Repo-relative path. */
  path: string;
  contents: string;
  /** Whether a file already exists there (so we can avoid clobbering). */
  exists: boolean;
}

/** Compute every file deploykit would write, without touching disk. */
export function planFiles({
  config,
  cwd,
}: {
  config: DeploykitConfig;
  cwd: string;
}) {
  const files: GeneratedFile[] = [];
  const add = (path: string, contents: string) =>
    files.push({ path, contents, exists: fileExists(join(cwd, path)) });

  add("deploykit.config.ts", generateConfigFile(config));
  add(".dockerignore", generateDockerignore());
  add(".github/workflows/deploy.yml", generateWorkflow(config));

  for (const [name, app] of Object.entries(config.apps)) {
    add(`${app.root}/Dockerfile`, generateDockerfile({ name, app, config }));
    add(`${app.root}/fly.toml`, generateFlyToml({ name, app, config }));
  }

  return files;
}

export interface WriteResult {
  written: string[];
  skipped: string[];
}

/**
 * Write generated files. Existing files are skipped unless `force`, so a re-run
 * never silently clobbers hand-edited Dockerfiles / fly.toml.
 */
export function writeFiles({
  files,
  cwd,
  force,
}: {
  files: GeneratedFile[];
  cwd: string;
  force: boolean;
}) {
  const written: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    if (f.exists && !force) {
      skipped.push(f.path);
      continue;
    }
    const abs = join(cwd, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.contents, "utf8");
    written.push(f.path);
  }
  return { written, skipped };
}
