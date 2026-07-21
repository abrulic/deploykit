import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DeploykitConfig } from "../config.js";
import { readText } from "../util/fsx.js";
import { readGithubRepo } from "../util/git.js";
import { generateConfigFile } from "./configfile.js";
import { generateDockerfile } from "./dockerfile.js";
import { generateDockerignore } from "./dockerignore.js";
import { generateFlyToml } from "./flytoml.js";
import { generateSummary } from "./summary.js";
import { generateWorkflow } from "./workflow.js";

/**
 * How a generated file compares to what's already on disk:
 * - `new`: nothing there yet.
 * - `identical`: the file matches what deploykit would generate (a no-op).
 * - `modified`: a file is there but differs — hand-edited or an older template.
 *   deploykit never silently overwrites this; the plan surfaces it.
 */
export type FileStatus = "new" | "identical" | "modified";

export interface GeneratedFile {
  /** Repo-relative path. */
  path: string;
  contents: string;
  /** How the on-disk file compares to `contents` (drives skip vs warn). */
  status: FileStatus;
}

/** True for a file that exists on disk, whether or not it matches. */
export const fileOnDisk = (f: GeneratedFile) => f.status !== "new";

/**
 * Classify generated content against what's on disk. Line endings and trailing
 * whitespace are normalized so a stray CRLF or final newline from an editor
 * doesn't read as a real edit.
 */
function classify(generated: string, existing: string | null): FileStatus {
  if (existing === null) return "new";
  const norm = (s: string) => s.replace(/\r\n/g, "\n").trimEnd();
  return norm(generated) === norm(existing) ? "identical" : "modified";
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
    files.push({
      path,
      contents,
      status: classify(contents, readText(join(cwd, path))),
    });

  add("deploykit.config.ts", generateConfigFile(config));
  add(".dockerignore", generateDockerignore());
  add(".github/workflows/deploy.yml", generateWorkflow(config));
  add("DEPLOYMENTS.md", generateSummary({ config, repo: readGithubRepo(cwd) }));

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
    // An identical file is a no-op, so skipping it loses nothing; a modified
    // file is left alone unless forced, so a hand-edit is never clobbered.
    if (fileOnDisk(f) && !force) {
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
