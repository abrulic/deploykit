import type {
  AppConfig,
  DeploykitConfig,
  PackageManager,
  ServeModel,
} from "../config.js";

export interface PmCommands {
  /** Run a locally-installed binary: pnpm | npx | yarn | bunx. */
  run: string;
  /** Run a package's own binary, resolving node_modules/.bin (`pnpm exec`, `npx`). */
  exec: string;
  /** Fetch and run a binary without a prior install (e.g. `turbo prune`). */
  dlx: string;
  /** Frozen install from the lockfile. */
  install: string;
}

export const PM: Record<PackageManager, PmCommands> = {
  pnpm: {
    run: "pnpm",
    exec: "pnpm exec",
    dlx: "pnpm dlx",
    install: "pnpm install --frozen-lockfile",
  },
  npm: {
    run: "npx",
    exec: "npx",
    dlx: "npx --yes",
    install: "npm ci",
  },
  yarn: {
    run: "yarn",
    exec: "yarn exec",
    dlx: "yarn dlx",
    install: "yarn install --frozen-lockfile",
  },
  bun: {
    run: "bunx",
    exec: "bunx",
    dlx: "bunx",
    install: "bun install",
  },
};

/**
 * How the runner serves an app. Prefers the detected `serve` field; falls back
 * to the framework for configs generated before that field existed.
 */
export const serveModel = (app: AppConfig): ServeModel =>
  app.serve ??
  (app.framework === "next" ||
  app.framework === "remix" ||
  app.framework === "react-router" ||
  app.framework === "node-server"
    ? "server"
    : "static");

/**
 * The install command, adjusted to neutralize `prepare` git-hook installers
 * that would otherwise fail without `git` in the image.
 *
 * Husky honors `HUSKY=0` before touching git, so an env prefix suffices and
 * dependency install-scripts still run. Lefthook resolves the git repository
 * *before* honoring `LEFTHOOK=0`, so the env var can't stop `lefthook install`
 * from crashing on the missing binary — for it we skip lifecycle scripts on the
 * install instead (`--ignore-scripts`). Prisma generate and the build run as
 * their own steps, so nothing needed at build time depends on those scripts.
 */
export const installLine = (pm: PmCommands, config: DeploykitConfig) => {
  const env = { ...config.installEnv };
  const ignoreScripts = "LEFTHOOK" in env;
  delete env.LEFTHOOK; // no-op at install time — dropped in favor of --ignore-scripts
  const prefix = Object.keys(env).length
    ? `${Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")} `
    : "";
  return `${prefix}${pm.install}${ignoreScripts ? " --ignore-scripts" : ""}`;
};

/**
 * ARG/ENV lines for the app's build-time vars (NEXT_PUBLIC_*, VITE_*, and all
 * vars of a static app). Declared in the build stage so `--build-arg` values
 * from CI are visible to the framework build and baked into the bundle —
 * setting them as Fly *runtime* secrets would be too late for these.
 */
export const buildEnvLines = (app: AppConfig): string => {
  const names = app.buildEnv ?? [];
  if (names.length === 0) return "";
  return `${names.map((n) => `ARG ${n}\nENV ${n}=$${n}`).join("\n")}\n`;
};

/**
 * `prisma generate` lines for every Prisma package in the app's closure. The
 * client isn't generated on install under pnpm 10 / Prisma 7, and workspace
 * packages fail to build without it. A throwaway build-time DATABASE_URL is set
 * because Prisma 7's config/adapters may read it at load (generate never connects).
 */
export const prismaSteps = (app: AppConfig, pm: PmCommands): string => {
  const targets = app.prisma ?? [];
  if (targets.length === 0) return "";
  const url = "postgresql://build:build@localhost:5432/build";
  return `${targets
    .map((t) => {
      const schema = t.hasConfig ? "" : ` --schema ./${t.schema}`;
      return `RUN cd ${t.root} && DATABASE_URL="${url}" ${pm.exec} prisma generate${schema}`;
    })
    .join("\n")}\n`;
};

/**
 * The runner CMD for a server app. Prefers the detected start command; falls
 * back to `npm start`, which runs the app's own `start` script. The runner is a
 * bare node image without the project's package manager (pnpm/yarn/bun), so we
 * can't use `<pm> start` there — but `npm`/`npx` ship with every node image, and
 * `npm start` runs a `start` script with `node_modules/.bin` on PATH regardless
 * of which manager built the workspace.
 */
export const serverCmd = (app: AppConfig): string =>
  JSON.stringify(app.startCommand ?? ["npm", "start"]);

export const nodeImage = (config: DeploykitConfig) =>
  `node:${config.nodeVersion}-slim`;

/**
 * Shared base stage: node image + corepack for pnpm/yarn. Corepack does not
 * manage bun, so a bun workspace installs it explicitly (bun's npm package
 * ships the binary — no curl needed on the slim image).
 */
export const baseStage = (config: DeploykitConfig) => {
  const bun = config.packageManager === "bun" ? "\nRUN npm install -g bun" : "";
  return `FROM ${nodeImage(config)} AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN corepack enable || true${bun}`;
};

/** Shared runner-stage header: image, workdir, env, non-root user, port. */
export const runnerHeader = ({ node, port }: { node: string; port: number }) =>
  `# ── runner ───────────────────────────────────────────────────────────────────
FROM ${node} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=${port}
RUN addgroup --system --gid 1001 nodejs \\
 && adduser --system --uid 1001 --ingroup nodejs appuser
EXPOSE ${port}`;

/** File header shared by both generators. */
export const fileHeader = ({ root, base }: { root: string; base: string }) =>
  `# syntax=docker/dockerfile:1
# Generated by deploykit — safe to edit and commit.
# Build context is the repo ROOT, e.g.:
#   flyctl deploy . --config ${root}/fly.toml --dockerfile ${root}/Dockerfile --app <app>

${base}`;
