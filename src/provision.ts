import type { DeploykitConfig } from "./config.js";
import { exec, tryExec } from "./util/exec.js";

export interface StepResult {
  label: string;
  ok: boolean;
  detail?: string;
}

/** Default name for the org deploy token, so it's identifiable on the dashboard. */
const FLY_TOKEN_NAME = "deploykit (GitHub Actions)";

/**
 * Create an **org-scoped deploy token** for CI.
 *
 * We deliberately use `flyctl tokens create org` rather than `flyctl auth
 * token`: the latter prints the user's personal credential (broad access to
 * every org, and invisible on the dashboard). An org token is least-privilege,
 * revocable, and shows up under Organization → Tokens. Returns the `FlyV1 …`
 * macaroon string on success.
 */
export async function createFlyOrgToken({
  org,
  cwd,
  name = FLY_TOKEN_NAME,
}: {
  org: string;
  cwd: string;
  name?: string;
}): Promise<{ ok: boolean; token?: string; detail?: string }> {
  const res = await exec({
    cmd: "flyctl",
    args: ["tokens", "create", "org", "--org", org, "--name", name],
    cwd,
  });
  if (res.code !== 0) {
    return { ok: false, detail: res.stderr.trim() || "flyctl tokens create org failed" };
  }
  const token = extractFlyToken(res.stdout) ?? extractFlyToken(res.stderr);
  if (!token) return { ok: false, detail: "couldn't parse token from flyctl output" };
  return { ok: true, token };
}

/** Pull the `FlyV1 …` macaroon out of flyctl's output (plain or JSON). */
export function extractFlyToken(raw: string): string | null {
  const m = raw.match(/FlyV1 [^\s"']+/);
  return m ? m[0] : null;
}

/** List Fly app names visible to the current auth, or null if it can't be read. */
export async function listFlyApps(cwd: string): Promise<string[] | null> {
  const out = await tryExec({ cmd: "flyctl", args: ["apps", "list", "--json"], cwd });
  if (!out) return null;
  try {
    const apps = JSON.parse(out) as Array<{ Name?: string; name?: string }>;
    return apps.map((a) => a.Name ?? a.name ?? "").filter(Boolean);
  } catch {
    return null;
  }
}

/** Create the long-lived Fly apps (staging/production). Previews are lazy. */
export async function createFlyApps({
  names,
  org,
  cwd,
}: {
  names: string[];
  org: string;
  cwd: string;
}) {
  const results: StepResult[] = [];
  for (const name of names) {
    const res = await exec({
      cmd: "flyctl",
      args: ["apps", "create", name, "--org", org],
      cwd,
    });
    const already = /already/i.test(res.stderr);
    results.push({
      label: `Create Fly app ${name}`,
      ok: res.code === 0 || already,
      detail: already
        ? "already exists"
        : res.code === 0
          ? undefined
          : res.stderr.trim(),
    });
  }
  return results;
}

/** Resolve the current repo as "owner/name", or null if gh can't determine it. */
export async function getRepo(cwd: string) {
  return tryExec({
    cmd: "gh",
    args: ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    cwd,
  });
}

/**
 * Set a single GitHub Actions secret. When `env` is given it's scoped to that
 * deployment environment (`gh secret set --env`); otherwise it's a repo-level
 * secret. Repo-level is what the preview job reads (it has no `environment:`),
 * while staging/production jobs read their environment secrets.
 */
export async function setGithubSecret({
  name,
  value,
  env,
  repo,
  cwd,
}: {
  name: string;
  value: string;
  env?: string;
  repo?: string | null;
  cwd: string;
}) {
  const args = ["secret", "set", name, "--body", value];
  if (env) args.push("--env", env);
  if (repo) args.push("--repo", repo);
  const res = await exec({ cmd: "gh", args, cwd });
  const scope = env ? ` → ${env}` : " → repo";
  return {
    label: `Set secret ${name}${scope}`,
    ok: res.code === 0,
    detail: res.code === 0 ? undefined : res.stderr.trim(),
  } satisfies StepResult;
}

/** Names of secrets already set at the repo or (with `env`) an environment. */
export async function listGithubSecretNames({
  env,
  repo,
  cwd,
}: {
  env?: string;
  repo?: string | null;
  cwd: string;
}): Promise<Set<string>> {
  const args = ["secret", "list", "--json", "name", "-q", ".[].name"];
  if (env) args.push("--env", env);
  if (repo) args.push("--repo", repo);
  const out = await tryExec({ cmd: "gh", args, cwd });
  if (!out) return new Set();
  return new Set(
    out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Names of existing GitHub deployment environments, or null if unreadable. */
export async function listGithubEnvironments({
  repo,
  cwd,
}: {
  repo: string;
  cwd: string;
}): Promise<string[] | null> {
  const out = await tryExec({
    cmd: "gh",
    args: ["api", `/repos/${repo}/environments`, "-q", ".environments[].name"],
    cwd,
  });
  if (out === null) return null;
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Ensure a single GitHub deployment environment exists (idempotent PUT). Env
 * secrets can't be set until the environment exists, so this runs first.
 */
export async function ensureGithubEnvironment({
  env,
  repo,
  cwd,
}: {
  env: string;
  repo: string;
  cwd: string;
}) {
  const res = await exec({
    cmd: "gh",
    args: ["api", "--method", "PUT", `/repos/${repo}/environments/${env}`],
    cwd,
  });
  return res.code === 0;
}

/**
 * Create the GitHub deployment environments (staging/production) that gate
 * deploys. Idempotent: environments that already exist are reported as skipped
 * rather than recreated.
 */
export async function createGithubEnvironments({
  config,
  cwd,
}: {
  config: DeploykitConfig;
  cwd: string;
}) {
  const repo = await getRepo(cwd);
  if (!repo) {
    return [
      {
        label: "Create GitHub environments",
        ok: false,
        detail: "could not resolve repo (gh repo view)",
      },
    ] satisfies StepResult[];
  }

  const kinds = new Set<string>();
  for (const app of Object.values(config.apps)) {
    if (app.environments.staging) kinds.add("staging");
    if (app.environments.production) kinds.add("production");
  }

  const existing = new Set((await listGithubEnvironments({ repo, cwd })) ?? []);
  const results: StepResult[] = [];
  for (const kind of kinds) {
    if (existing.has(kind)) {
      results.push({ label: `GitHub environment ${kind}`, ok: true, detail: "already exists" });
      continue;
    }
    const ok = await ensureGithubEnvironment({ env: kind, repo, cwd });
    results.push({
      label: `Create GitHub environment ${kind}`,
      ok,
      detail: ok ? undefined : "gh api PUT failed",
    });
  }
  return results;
}
