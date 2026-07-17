import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Framework, MonorepoTool, PackageManager } from "./config.js";
import { DEFAULT_PORTS } from "./config.js";
import {
  expandWorkspaceGlob,
  fileExists,
  findFilesByName,
  listDir,
  readJson,
  readText,
  toPosix,
  walkFilesByExt,
} from "./util/fsx.js";

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
  packageManager?: string;
}

interface NxProjectJson {
  name?: string;
  projectType?: "application" | "library";
  targets?: Record<string, { executor?: string }>;
  implicitDependencies?: string[];
}

export interface DetectedApp {
  /** Short name — the last path segment, used as the config key and app prefix. */
  name: string;
  root: string;
  packageName: string;
  framework: Framework;
  deployable: boolean;
  port: number;
  /** Transitive internal workspace deps (package names). */
  internalDeps: string[];
  /** Globs that should trigger a redeploy: own dir + every internal dep dir. */
  watchPaths: string[];
  secrets: string[];
  hasDockerfile: boolean;
  hasFlyToml: boolean;
}

export interface DetectedLib {
  name: string;
  root: string;
  packageName: string;
}

export interface Detection {
  tool: MonorepoTool;
  packageManager: PackageManager;
  nodeVersion: string;
  apps: DetectedApp[];
  libs: DetectedLib[];
  hasExistingWorkflows: boolean;
}

interface Projects {
  apps: DetectedApp[];
  libs: DetectedLib[];
}

interface RawPackage {
  name: string;
  dir: string;
  pkg: PackageJson;
  directDeps: string[];
}

const ENV_DENYLIST = new Set([
  "NODE_ENV",
  "PORT",
  "CI",
  "HOME",
  "PATH",
  "PWD",
  "HOSTNAME",
]);

export function detect(cwd: string) {
  const tool: MonorepoTool = fileExists(join(cwd, "turbo.json"))
    ? "turbo"
    : "nx";
  const packageManager = detectPackageManager(cwd);
  const nodeVersion = detectNodeVersion(cwd);

  const { apps, libs } = detectProjects({ cwd, tool });
  apps.sort((a, b) => a.name.localeCompare(b.name));
  libs.sort((a, b) => a.name.localeCompare(b.name));

  const hasExistingWorkflows = listDir(join(cwd, ".github", "workflows")).some(
    (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
  );

  return { tool, packageManager, nodeVersion, apps, libs, hasExistingWorkflows };
}

function detectProjects({ cwd, tool }: { cwd: string; tool: MonorepoTool }): Projects {
  if (tool === "nx") {
    const nx = detectNxProjects({ cwd });
    // Integrated Nx uses project.json; package-based Nx falls back to package.json.
    if (nx.apps.length || nx.libs.length) return nx;
  }
  return detectPackageProjects({ cwd, tool });
}

// ── Package-based detection (Turbo, or Nx with per-package package.json) ──────
function detectPackageProjects({
  cwd,
  tool,
}: {
  cwd: string;
  tool: MonorepoTool;
}): Projects {
  const dirs = new Set<string>();
  for (const pattern of workspaceGlobs(cwd)) {
    for (const dir of expandWorkspaceGlob({ root: cwd, pattern })) {
      dirs.add(toPosix(dir));
    }
  }

  const raw = readPackages({ cwd, dirs });
  const byName = new Map(raw.map((r) => [r.name, r]));
  const dirByName = new Map(raw.map((r) => [r.name, r.dir]));

  const apps: DetectedApp[] = [];
  const libs: DetectedLib[] = [];

  for (const r of raw) {
    const framework = detectFramework(r.pkg);
    const scripts = r.pkg.scripts ?? {};
    const underApps = r.dir.startsWith("apps/");
    const hasServeScript = Boolean(scripts.start || scripts.serve);
    const inherentlyApp =
      framework === "next" || framework === "remix" || framework === "astro";
    const deployable =
      framework !== null && (inherentlyApp || underApps || hasServeScript);

    if (framework === null || !deployable) {
      libs.push({ name: lastSegment(r.dir), root: r.dir, packageName: r.name });
      continue;
    }

    const internalDeps = transitiveDeps(r.name, byName);
    const depDirs = internalDeps
      .map((n) => dirByName.get(n))
      .filter((d): d is string => Boolean(d));

    apps.push({
      name: lastSegment(r.dir),
      root: r.dir,
      packageName: r.name,
      framework,
      deployable: true,
      port: DEFAULT_PORTS[framework],
      internalDeps,
      watchPaths: [
        `${r.dir}/**`,
        ...depDirs.map((d) => `${d}/**`),
        "package.json",
        `${tool}.json`,
      ],
      secrets: detectSecrets({ cwd, appDir: r.dir }),
      hasDockerfile: fileExists(join(cwd, r.dir, "Dockerfile")),
      hasFlyToml: fileExists(join(cwd, r.dir, "fly.toml")),
    });
  }

  return { apps, libs };
}

// ── Nx detection (integrated repos, via project.json) ────────────────────────
function detectNxProjects({ cwd }: { cwd: string }): Projects {
  const projects = findFilesByName({ root: cwd, filename: "project.json", limit: 1000 })
    .map((file) => {
      const proj = readJson<NxProjectJson>(join(cwd, file));
      if (!proj) return null;
      const root = toPosix(dirname(file));
      return { proj, root, name: proj.name ?? lastSegment(root) };
    })
    .filter((p): p is { proj: NxProjectJson; root: string; name: string } =>
      p !== null,
    );

  const rootByName = new Map(projects.map((p) => [p.name, p.root]));
  const apps: DetectedApp[] = [];
  const libs: DetectedLib[] = [];

  for (const { proj, root, name } of projects) {
    if (isNxLibrary({ proj, root })) {
      libs.push({ name: lastSegment(root), root, packageName: name });
      continue;
    }

    const framework = nxFramework(proj);
    const internalDeps = proj.implicitDependencies ?? [];
    const depDirs = internalDeps
      .map((d) => rootByName.get(d))
      .filter((d): d is string => Boolean(d));

    apps.push({
      name: lastSegment(root),
      root,
      packageName: name,
      framework,
      deployable: true,
      port: DEFAULT_PORTS[framework],
      internalDeps,
      watchPaths: [
        `${root}/**`,
        ...depDirs.map((d) => `${d}/**`),
        "package.json",
        "nx.json",
      ],
      secrets: detectSecrets({ cwd, appDir: root }),
      hasDockerfile: fileExists(join(cwd, root, "Dockerfile")),
      hasFlyToml: fileExists(join(cwd, root, "fly.toml")),
    });
  }

  return { apps, libs };
}

function isNxLibrary({ proj, root }: { proj: NxProjectJson; root: string }) {
  if (proj.projectType === "library") return true;
  if (proj.projectType === "application") return false;
  // No explicit type — infer from conventional location.
  return root.startsWith("libs/") || root.startsWith("packages/");
}

/** Infer an Nx application's framework from its build executor. */
function nxFramework(proj: NxProjectJson): Framework {
  const executors = Object.values(proj.targets ?? {})
    .map((t) => t.executor ?? "")
    .join(" ");
  if (/next/.test(executors)) return "next";
  if (/remix/.test(executors)) return "remix";
  if (/astro/.test(executors)) return "astro";
  if (/vite/.test(executors)) return "vite";
  // webpack/esbuild/node/nest/rollup/tsc → a Node server bundle (the default).
  return "node-server";
}

function readPackages({ cwd, dirs }: { cwd: string; dirs: Set<string> }) {
  const raw: RawPackage[] = [];
  for (const dir of dirs) {
    const pkg = readJson<PackageJson>(join(cwd, dir, "package.json"));
    if (!pkg?.name) continue;
    raw.push({ name: pkg.name, dir, pkg, directDeps: [] });
  }
  const names = new Set(raw.map((r) => r.name));
  for (const r of raw) {
    const allDeps = {
      ...(r.pkg.dependencies ?? {}),
      ...(r.pkg.devDependencies ?? {}),
    };
    r.directDeps = Object.keys(allDeps).filter((d) => names.has(d));
  }
  return raw;
}

function detectPackageManager(cwd: string): PackageManager {
  // 1. The authoritative `packageManager` field, e.g. "pnpm@9.0.0".
  const pkg = readJson<PackageJson>(join(cwd, "package.json"));
  const field = pkg?.packageManager?.split("@")[0];
  if (field === "pnpm" || field === "yarn" || field === "npm" || field === "bun")
    return field;

  // 2. Lockfiles.
  if (fileExists(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fileExists(join(cwd, "bun.lockb")) || fileExists(join(cwd, "bun.lock")))
    return "bun";
  if (fileExists(join(cwd, "yarn.lock"))) return "yarn";
  if (fileExists(join(cwd, "package-lock.json"))) return "npm";

  // 3. A pnpm workspace file strongly implies pnpm.
  if (fileExists(join(cwd, "pnpm-workspace.yaml"))) return "pnpm";

  return "npm";
}

function detectNodeVersion(cwd: string) {
  const nvmrc = readText(join(cwd, ".nvmrc"));
  const fromNvmrc = nvmrc?.trim().replace(/^v/, "").match(/^(\d+)/)?.[1];
  if (fromNvmrc) return fromNvmrc;

  const pkg = readJson<PackageJson>(join(cwd, "package.json"));
  const fromEngines = pkg?.engines?.node?.match(/(\d+)/)?.[1];
  if (fromEngines) return fromEngines;

  return "20";
}

function workspaceGlobs(cwd: string) {
  const ws = readText(join(cwd, "pnpm-workspace.yaml"));
  if (ws) {
    try {
      const parsed: { packages?: string[] } | null = parseYaml(ws);
      if (parsed?.packages?.length) return parsed.packages;
    } catch {
      /* fall through */
    }
  }
  const pkg = readJson<{ workspaces?: string[] | { packages?: string[] } }>(
    join(cwd, "package.json"),
  );
  const w = pkg?.workspaces;
  if (Array.isArray(w) && w.length) return w;
  if (w && !Array.isArray(w) && w.packages?.length) return w.packages;
  return ["apps/*", "packages/*"];
}

/** Map an app's dependencies to a deploy framework, or null for a library. */
export function detectFramework(pkg: PackageJson): Framework | null {
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };
  const has = (name: string) => Boolean(deps[name]);
  const hasPrefix = (prefix: string) =>
    Object.keys(deps).some((d) => d.startsWith(prefix));

  if (has("next")) return "next";
  if (hasPrefix("@remix-run/")) return "remix";
  if (has("astro")) return "astro";
  if (
    has("express") ||
    has("fastify") ||
    has("@nestjs/core") ||
    has("hono") ||
    has("koa")
  )
    return "node-server";
  if (has("vite")) return "vite";
  return null;
}

/** Transitive closure of internal deps, excluding the package itself. */
function transitiveDeps(start: string, byName: Map<string, RawPackage>) {
  const seen = new Set<string>();
  const stack = [...(byName.get(start)?.directDeps ?? [])];
  while (stack.length) {
    const n = stack.pop();
    if (!n || seen.has(n) || n === start) continue;
    seen.add(n);
    for (const d of byName.get(n)?.directDeps ?? []) {
      if (!seen.has(d)) stack.push(d);
    }
  }
  return [...seen].sort();
}

function detectSecrets({ cwd, appDir }: { cwd: string; appDir: string }) {
  const names = new Set<string>();
  const envFiles = [
    ".env.example",
    ".env.sample",
    ".env.template",
    ".env.local.example",
  ];
  for (const base of [cwd, join(cwd, appDir)]) {
    for (const f of envFiles) {
      const text = readText(join(base, f));
      if (!text) continue;
      for (const line of text.split("\n")) {
        const key = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/)?.[1];
        if (key) names.add(key);
      }
    }
  }

  const files = walkFilesByExt({
    root: cwd,
    subdir: appDir,
    exts: ["ts", "tsx", "js", "jsx", "mjs"],
    limit: 200,
  });
  for (const f of files) {
    const text = readText(join(cwd, f));
    if (!text) continue;
    const re = /process\.env\.([A-Z][A-Z0-9_]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m[1]) names.add(m[1]);
    }
  }
  return [...names].filter((n) => !ENV_DENYLIST.has(n)).sort();
}

const lastSegment = (p: string) => p.split("/").at(-1) ?? p;
