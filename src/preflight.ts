import { join } from "node:path";
import { commandExists, exec } from "./util/exec.js";
import { fileExists } from "./util/fsx.js";

export interface PreflightResult {
  ok: boolean;
  /** Fatal problems that stop the run. */
  errors: string[];
  /** Non-fatal problems worth surfacing. */
  warnings: string[];
  /** Whether `gh` is authenticated (needed for --pr / --provision). */
  ghReady: boolean;
  /** Whether `flyctl` is authenticated (needed for --provision). */
  flyReady: boolean;
  /** Whether a CLOUDFLARE_API_TOKEN is present (needed for custom-domain wiring). */
  cfReady: boolean;
}

/**
 * Phase 0 — fail fast before we ask the user anything.
 *
 * Hard requirements: a git repo containing a Turbo (or Nx) monorepo.
 * Soft requirements: gh + flyctl auth, only needed if the user later opts into
 * provisioning or opening a PR.
 */
export async function preflight(cwd: string) {
  const errors: string[] = [];
  const warnings: string[] = [];

  const inGit = await exec({
    cmd: "git",
    args: ["rev-parse", "--is-inside-work-tree"],
    cwd,
  });
  if (inGit.code !== 0) {
    errors.push(
      "Not a git repository. Run `git init` first — deploykit opens a PR with the generated files.",
    );
  }

  const hasTurbo = fileExists(join(cwd, "turbo.json"));
  const hasNx = fileExists(join(cwd, "nx.json"));
  if (!hasTurbo && !hasNx) {
    errors.push(
      "No monorepo tool found (looked for turbo.json / nx.json). deploykit supports Turbo and Nx monorepos.",
    );
  } else if (!hasTurbo && hasNx) {
    warnings.push(
      "Detected an Nx monorepo. Nx Dockerfiles use standard conventions (dist/<projectRoot>); double-check the paths for Next/SSR apps before your first deploy.",
    );
  }

  if (inGit.code === 0) {
    const status = await exec({
      cmd: "git",
      args: ["status", "--porcelain"],
      cwd,
    });
    if (status.stdout.trim().length > 0) {
      warnings.push(
        "Working tree has uncommitted changes. deploykit will add files on top; commit or stash first if you want a clean PR.",
      );
    }
  }

  // Auth readiness is detected here but *messaged* by the auth step (src/auth.ts),
  // which can also drive an interactive login — so preflight stays silent about it
  // and there's a single place that talks about signing in.
  const ghReady = await isAuthed({
    cmd: "gh",
    authArgs: ["auth", "status"],
    cwd,
  });
  const flyReady = await isAuthed({
    cmd: "flyctl",
    authArgs: ["auth", "whoami"],
    cwd,
  });

  // Cloudflare token is resolved lazily during the domain step (env →
  // .deploykit/credentials → prompt), so no startup warning here.
  const cfReady = Boolean(process.env.CLOUDFLARE_API_TOKEN?.trim());

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    ghReady,
    flyReady,
    cfReady,
  };
}

/** True if `cmd` exists and its auth-status check exits 0. */
async function isAuthed({
  cmd,
  authArgs,
  cwd,
}: {
  cmd: string;
  authArgs: string[];
  cwd: string;
}): Promise<boolean> {
  if (!(await commandExists(cmd))) return false;
  const res = await exec({ cmd, args: authArgs, cwd });
  return res.code === 0;
}
