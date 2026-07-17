import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const fileExists = (path: string) => existsSync(path);

export function readJson<T = unknown>(path: string) {
  try {
    const parsed: T = JSON.parse(readFileSync(path, "utf8"));
    return parsed;
  } catch {
    return null;
  }
}

export function readText(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".github",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
]);

/**
 * Recursively collect workspace-relative directories that contain a
 * package.json, skipping ignored dirs. Bounded depth keeps it cheap.
 */
function packageDirs(root: string, maxDepth = 5) {
  const out: string[] = [];
  const walk = (abs: string, rel: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    if (rel && entries.includes("package.json")) out.push(rel);
    for (const name of entries) {
      if (IGNORE_DIRS.has(name) || name.startsWith(".")) continue;
      const childAbs = join(abs, name);
      try {
        if (statSync(childAbs).isDirectory()) {
          walk(childAbs, rel ? `${rel}/${name}` : name, depth + 1);
        }
      } catch {
        /* ignore unreadable entries */
      }
    }
  };
  walk(root, "", 0);
  return out;
}

/** Convert a workspace glob (apps/*, packages/**) into an anchored regex. */
export function globToRegex(pattern: string) {
  const cleaned = pattern.replace(/\/+$/, "");
  const escaped = cleaned
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, " ") // placeholder for **
    .replace(/\*/g, "[^/]+")
    .replace(/ /g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Directories matching a workspace glob that contain a package.json. */
export function expandWorkspaceGlob({
  root,
  pattern,
}: {
  root: string;
  pattern: string;
}) {
  const re = globToRegex(pattern);
  return packageDirs(root).filter((d) => re.test(d));
}

export interface WalkFilesInput {
  root: string;
  subdir: string;
  exts: string[];
  limit: number;
}

/**
 * Collect files with the given extensions under `subdir`, capped at `limit`.
 * Used for the bounded env-var source scan.
 */
export function walkFilesByExt({ root, subdir, exts, limit }: WalkFilesInput) {
  const out: string[] = [];
  const extSet = new Set(exts.map((e) => (e.startsWith(".") ? e : `.${e}`)));
  const walk = (abs: string, rel: string) => {
    if (out.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= limit) return;
      if (IGNORE_DIRS.has(name)) continue;
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let isDir = false;
      try {
        isDir = statSync(childAbs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(childAbs, childRel);
      } else if (extSet.has(extname(name))) {
        out.push(childRel);
      }
    }
  };
  walk(join(root, subdir), subdir);
  return out;
}

const extname = (name: string) => {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i);
};

/** List filenames directly inside a directory (empty if missing). */
export function listDir(path: string) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

export const toPosix = (path: string) => path.split("\\").join("/");
