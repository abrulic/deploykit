import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  Framework,
  MonorepoTool,
  PackageManager,
  PrismaTarget,
  ServeModel,
} from "./config.js";
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
  /** How the runner serves this app (derived from framework + config files). */
  serve: ServeModel;
  /** Exec-form CMD for a server app; omitted → run the app's own start script. */
  startCommand?: string[];
  /** For static apps: the built directory to serve. */
  outputDir?: string;
  /** For static apps: serve with SPA history fallback. */
  spa?: boolean;
  /** Prisma packages in this app's dependency closure needing `prisma generate`. */
  prisma?: PrismaTarget[];
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
  /** Env to neutralize `prepare` git-hook installers during the Docker install. */
  installEnv?: Record<string, string>;
  /** Nx only: true = integrated (project.json); false = package-based. */
  nxIntegrated?: boolean;
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

export function detect(cwd: string): Detection {
  const tool: MonorepoTool = fileExists(join(cwd, "turbo.json"))
    ? "turbo"
    : "nx";
  const packageManager = detectPackageManager(cwd);

  const { apps, libs, nxIntegrated } = detectProjects({ cwd, tool, packageManager });
  apps.sort((a, b) => a.name.localeCompare(b.name));
  libs.sort((a, b) => a.name.localeCompare(b.name));

  // Node version depends on the apps' own engines, so resolve it after detection.
  const nodeVersion = detectNodeVersion({ cwd, appRoots: apps.map((a) => a.root) });

  // Prisma: scan every package once, then assign each app the targets that fall
  // inside its dependency closure (keeps `turbo prune` honest for multi-db repos).
  const prismaTargets = detectPrismaTargets({
    cwd,
    roots: [...apps, ...libs].map((p) => ({ packageName: p.packageName, root: p.root })),
  });
  if (prismaTargets.length) {
    for (const app of apps) {
      const closure = new Set([app.packageName, ...app.internalDeps]);
      const appPrisma = prismaTargets.filter((t) => closure.has(t.packageName));
      if (appPrisma.length) app.prisma = appPrisma;
    }
  }

  const hasExistingWorkflows = listDir(join(cwd, ".github", "workflows")).some(
    (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
  );

  const detection: Detection = {
    tool,
    packageManager,
    nodeVersion,
    apps,
    libs,
    hasExistingWorkflows,
  };
  const installEnv = detectInstallEnv(cwd);
  if (installEnv) detection.installEnv = installEnv;
  if (tool === "nx") detection.nxIntegrated = nxIntegrated;
  return detection;
}

function detectProjects({
  cwd,
  tool,
  packageManager,
}: {
  cwd: string;
  tool: MonorepoTool;
  packageManager: PackageManager;
}): Projects & { nxIntegrated: boolean } {
  if (tool === "nx") {
    const nx = detectNxProjects({ cwd, packageManager });
    // Integrated Nx uses project.json; package-based Nx falls back to package.json.
    if (nx.apps.length || nx.libs.length) return { ...nx, nxIntegrated: true };
  }
  return { ...detectPackageProjects({ cwd, tool, packageManager }), nxIntegrated: false };
}

// ── Package-based detection (Turbo, or Nx with per-package package.json) ──────
function detectPackageProjects({
  cwd,
  tool,
  packageManager,
}: {
  cwd: string;
  tool: MonorepoTool;
  packageManager: PackageManager;
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

    const serveInfo = detectServeModel({
      pkg: r.pkg,
      framework,
      appAbs: join(cwd, r.dir),
      root: r.dir,
      nxIntegrated: false,
      tool,
      packageManager,
    });

    apps.push({
      name: lastSegment(r.dir),
      root: r.dir,
      packageName: r.name,
      framework,
      ...serveInfo,
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
function detectNxProjects({
  cwd,
  packageManager,
}: {
  cwd: string;
  packageManager: PackageManager;
}): Projects {
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

    const serveInfo = detectServeModel({
      pkg: readJson<PackageJson>(join(cwd, root, "package.json")) ?? undefined,
      framework,
      appAbs: join(cwd, root),
      root,
      nxIntegrated: true,
      tool: "nx",
      packageManager,
    });

    apps.push({
      name: lastSegment(root),
      root,
      packageName: name,
      framework,
      ...serveInfo,
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

/**
 * Highest Node major any project asks for. Considers `.nvmrc`, the root
 * `engines.node`, and every app's own `engines.node` — an app that needs Node
 * 22 must not be built on the root's Node 20. Defaults to "20".
 */
function detectNodeVersion({ cwd, appRoots }: { cwd: string; appRoots: string[] }) {
  const majors: number[] = [];

  const nvmrc = readText(join(cwd, ".nvmrc"));
  const fromNvmrc = nvmrc?.trim().replace(/^v/, "").match(/^(\d+)/)?.[1];
  if (fromNvmrc) majors.push(Number(fromNvmrc));

  const enginesMajor = (dir: string) =>
    readJson<PackageJson>(join(dir, "package.json"))?.engines?.node?.match(/(\d+)/)?.[1];
  const root = enginesMajor(cwd);
  if (root) majors.push(Number(root));
  for (const appRoot of appRoots) {
    const m = enginesMajor(join(cwd, appRoot));
    if (m) majors.push(Number(m));
  }

  return majors.length ? String(Math.max(...majors)) : "20";
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
  // React Router 7 framework mode is signalled by the dev plugin specifically
  // (a plain SPA can depend on `react-router` for routing without it).
  if (has("@react-router/dev")) return "react-router";
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

/** Per-package-manager prefix to run a locally-installed binary (resolves .bin). */
const EXEC_PREFIX: Record<PackageManager, string[]> = {
  pnpm: ["pnpm", "exec"],
  npm: ["npx"],
  yarn: ["yarn", "exec"],
  bun: ["bunx"],
};

interface ServeInfo {
  serve: ServeModel;
  startCommand?: string[];
  outputDir?: string;
  spa?: boolean;
}

/**
 * Decide how the runner serves an app — static files vs a long-running process —
 * plus the served dir (static) or run command (server). Keyed off framework +
 * a couple of config-file / dependency signals, NOT a hardcoded per-framework
 * runner. `pkg`/`appAbs` may be absent for integrated-Nx apps with no package.json.
 */
function detectServeModel({
  pkg,
  framework,
  appAbs,
  root,
  nxIntegrated,
  tool,
  packageManager,
}: {
  pkg?: PackageJson;
  framework: Framework;
  appAbs?: string;
  root: string;
  nxIntegrated: boolean;
  tool: MonorepoTool;
  packageManager: PackageManager;
}): ServeInfo {
  // Nx integrated writes to dist/<root>; turbo / package-based write in the pkg dir.
  const staticBase = tool === "nx" && nxIntegrated ? `dist/${root}` : `${root}/dist`;
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const server = (startCommand?: string[]): ServeInfo => ({ serve: "server", startCommand });

  switch (framework) {
    case "next":
    case "remix":
    case "node-server":
      return server(resolveStartCommand({ pkg, framework, packageManager }));

    case "react-router": {
      // Framework mode: SSR by default; only `ssr:false` yields a static SPA.
      if (reactRouterSsr(appAbs)) {
        return server(resolveStartCommand({ pkg, framework, packageManager }));
      }
      return { serve: "static", outputDir: `${root}/build/client`, spa: true };
    }

    case "astro":
      // A node adapter turns Astro into a server; otherwise it's a static site.
      if (deps["@astrojs/node"]) {
        return server(resolveStartCommand({ pkg, framework, packageManager }));
      }
      return { serve: "static", outputDir: staticBase, spa: false };

    default:
      // vite | static — a client-only SPA / static site.
      return { serve: "static", outputDir: staticBase, spa: framework === "vite" };
  }
}

/** True unless a react-router.config.{ts,js} explicitly sets `ssr: false`. */
function reactRouterSsr(appAbs?: string): boolean {
  if (!appAbs) return true;
  const text =
    readText(join(appAbs, "react-router.config.ts")) ??
    readText(join(appAbs, "react-router.config.js"));
  if (!text) return true; // no config → framework default is ssr: true
  return !/\bssr\s*:\s*false\b/.test(text);
}

/**
 * The run command for a server app, or undefined to let the runner invoke the
 * app's own `start` script via the package manager. A clean single-command
 * `start` is left to the package manager (it resolves node_modules/.bin). Only
 * when `start` is container-hostile (env sourcing, chained `&&`) or missing do
 * we synthesize a known-good command per framework.
 */
function resolveStartCommand({
  pkg,
  framework,
  packageManager,
}: {
  pkg?: PackageJson;
  framework: Framework;
  packageManager: PackageManager;
}): string[] | undefined {
  const start = pkg?.scripts?.start?.trim();
  if (start && isCleanStart(start)) return undefined; // runner uses `<pm> start`

  const exec = EXEC_PREFIX[packageManager];
  if (framework === "react-router")
    return [...exec, "react-router-serve", "./build/server/index.js"];
  if (framework === "astro") return ["node", "./dist/server/entry.mjs"];
  return undefined; // best effort: runner falls back to `<pm> start`
}

/** A `start` script safe to run verbatim: no shell operators / env sourcing. */
function isCleanStart(start: string): boolean {
  return !/[&|;`$<>]|(^|\s)set\s+-a(\s|$)|(^|\s)source\s|(^|\s)\.\s/.test(start);
}

/**
 * Workspace packages that ship a Prisma schema — their client isn't generated
 * on install under pnpm 10 / Prisma 7, so the Dockerfile must run
 * `prisma generate` before building. A package qualifies via a schema file, a
 * prisma.config, or the `prisma` + `@prisma/client` dep pair.
 */
function detectPrismaTargets({
  cwd,
  roots,
}: {
  cwd: string;
  roots: { packageName: string; root: string }[];
}): PrismaTarget[] {
  const targets: PrismaTarget[] = [];
  for (const { packageName, root } of roots) {
    const base = join(cwd, root);
    const hasSchema = fileExists(join(base, "prisma", "schema.prisma"));
    const hasConfig =
      fileExists(join(base, "prisma.config.ts")) ||
      fileExists(join(base, "prisma.config.js"));
    const pkg = readJson<PackageJson>(join(base, "package.json"));
    const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
    const hasDeps = Boolean(deps.prisma) && Boolean(deps["@prisma/client"]);
    if (hasSchema || hasConfig || hasDeps) {
      targets.push({ packageName, root, schema: "prisma/schema.prisma", hasConfig });
    }
  }
  return targets;
}

/**
 * Env that neutralizes a `prepare` git-hook installer during the Docker install.
 * These hooks (lefthook/husky) shell out to `git`, which the slim image lacks
 * and `.dockerignore` strips — so disable the installer rather than adding git.
 */
function detectInstallEnv(cwd: string): Record<string, string> | undefined {
  const prepare = readJson<PackageJson>(join(cwd, "package.json"))?.scripts?.prepare;
  if (!prepare) return undefined;
  const env: Record<string, string> = {};
  if (/lefthook/.test(prepare)) env.LEFTHOOK = "0";
  if (/husky/.test(prepare)) env.HUSKY = "0";
  return Object.keys(env).length ? env : undefined;
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
