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
      "No monorepo tool found (looked for turbo.json / nx.json). deploykit v1 targets Turbo monorepos.",
    );
  } else if (!hasTurbo && hasNx) {
    warnings.push(
      "Detected an Nx monorepo. Detection works, but Dockerfile generation is Turbo-only in v1.",
    );
  }

  if (inGit.code === 0) {
    const status = await exec({ cmd: "git", args: ["status", "--porcelain"], cwd });
    if (status.stdout.trim().length > 0) {
      warnings.push(
        "Working tree has uncommitted changes. deploykit will add files on top; commit or stash first if you want a clean PR.",
      );
    }
  }

  const { ready: ghReady } = await checkAuth({
    cmd: "gh",
    authArgs: ["auth", "status"],
    cwd,
    label: "`gh` (GitHub CLI)",
    needFor: "--pr / --provision",
    warnings,
  });

  const { ready: flyReady } = await checkAuth({
    cmd: "flyctl",
    authArgs: ["auth", "whoami"],
    cwd,
    label: "`flyctl`",
    needFor: "--provision",
    warnings,
  });

  return { ok: errors.length === 0, errors, warnings, ghReady, flyReady };
}

interface CheckAuthInput {
  cmd: string;
  authArgs: string[];
  cwd: string;
  label: string;
  needFor: string;
  warnings: string[];
}

async function checkAuth({
  cmd,
  authArgs,
  cwd,
  label,
  needFor,
  warnings,
}: CheckAuthInput) {
  if (!(await commandExists(cmd))) {
    warnings.push(`${label} not found. Needed only for ${needFor}.`);
    return { ready: false };
  }
  const res = await exec({ cmd, args: authArgs, cwd });
  if (res.code !== 0) {
    warnings.push(`${label} is installed but not authenticated. Needed only for ${needFor}.`);
    return { ready: false };
  }
  return { ready: true };
}
