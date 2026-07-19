import type { DeploykitConfig } from "./config.js";
import { type ExecResult, exec, tryExec } from "./util/exec.js";

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
    return {
      ok: false,
      detail: res.stderr.trim() || "flyctl tokens create org failed",
    };
  }
  const token = extractFlyToken(res.stdout) ?? extractFlyToken(res.stderr);
  if (!token)
    return { ok: false, detail: "couldn't parse token from flyctl output" };
  return { ok: true, token };
}

/** Pull the `FlyV1 …` macaroon out of flyctl's output (plain or JSON). */
export function extractFlyToken(raw: string): string | null {
  const m = raw.match(/FlyV1 [^\s"']+/);
  return m ? m[0] : null;
}

/** List Fly app names visible to the current auth, or null if it can't be read. */
export async function listFlyApps(cwd: string): Promise<string[] | null> {
  const out = await tryExec({
    cmd: "flyctl",
    args: ["apps", "list", "--json"],
    cwd,
  });
  if (!out) return null;
  try {
    const apps: Array<{ Name?: string; name?: string }> = JSON.parse(out);
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
      detail: appCreateDetail({ already, res }),
    });
  }
  return results;
}

/** Detail line for a Fly app-create: existing apps and clean creates carry none. */
function appCreateDetail({
  already,
  res,
}: {
  already: boolean;
  res: ExecResult;
}) {
  if (already) return "already exists";
  if (res.code === 0) return undefined;
  return res.stderr.trim();
}

/** A user-facing DNS record that points a custom hostname at the Fly app. */
export interface FlyCertRecord {
  type: "CNAME" | "A" | "AAAA";
  /** The custom hostname the record is for. */
  name: string;
  /** CNAME target or A/AAAA address. */
  content: string;
}

export interface FlyCertInfo {
  ok: boolean;
  detail?: string;
  /** True once Fly has validated and issued the certificate. */
  configured?: boolean;
  /** Fly's status string, e.g. "Awaiting configuration" / "Ready". */
  status?: string;
  /**
   * The record(s) that route the hostname to Fly: a CNAME to Fly's target for a
   * subdomain, or A/AAAA for an apex. Empty when Fly returned no target (e.g.
   * an app with no allocated IPs) — the caller surfaces that rather than
   * silently doing nothing.
   */
  records?: FlyCertRecord[];
  /** The DNS-only ACME challenge CNAME Fly uses for DNS-01 validation. */
  acmeChallenge?: { name: string; target: string };
  /**
   * The DNS-only `_fly-ownership` TXT record. Fly asks for this to prove domain
   * control when it can't see the origin IPs — which is always the case behind
   * Cloudflare's proxy, so it's essential for a proxied setup.
   */
  ownership?: { name: string; value: string };
}

/**
 * Ensure a Fly cert exists for `hostname` on `app` and return the DNS records
 * Fly needs to validate and route it. Idempotent: `flyctl certs add` returns
 * the existing cert's requirements when one already exists, so re-runs are safe.
 */
export async function ensureFlyCert({
  hostname,
  app,
  cwd,
}: {
  hostname: string;
  app: string;
  cwd: string;
}): Promise<FlyCertInfo> {
  // `add` is the current name (`create` is an alias); it returns the cert's
  // dns_requirements as JSON, and is idempotent for an existing hostname.
  const add = await exec({
    cmd: "flyctl",
    args: ["certs", "add", hostname, "-a", app, "--json"],
    cwd,
  });
  let raw = add.stdout;
  if (add.code !== 0) {
    // Fall back to `show` if add reported the cert already exists.
    if (/already|exists/i.test(add.stderr)) {
      const show = await exec({
        cmd: "flyctl",
        args: ["certs", "show", hostname, "-a", app, "--json"],
        cwd,
      });
      if (show.code !== 0) return { ok: false, detail: show.stderr.trim() };
      raw = show.stdout;
    } else {
      return {
        ok: false,
        detail: add.stderr.trim() || "flyctl certs add failed",
      };
    }
  }
  return { ok: true, ...parseCertRequirements(raw) };
}

/** Trailing dots are valid in FQDNs but Cloudflare records don't want them. */
const stripDot = (s: string) => s.replace(/\.$/, "");

/**
 * Parse `flyctl certs` JSON into the records to create. Reads the real
 * `dns_requirements` shape (flyctl ≥ 0.4): `cname` for subdomains, `a`/`aaaa`
 * for apexes, plus the `acme_challenge` and `ownership` records. Returns empty
 * pieces (never throws) for anything absent, so a schema drift degrades to a
 * visible "no target" rather than a crash.
 */
export function parseCertRequirements(
  raw: string,
): Omit<FlyCertInfo, "ok" | "detail"> {
  let obj: {
    hostname?: string;
    configured?: boolean;
    status?: string;
    dns_requirements?: {
      cname?: string;
      a?: unknown[];
      aaaa?: unknown[];
      acme_challenge?: { name?: string; target?: string };
      ownership?: { name?: string; app_value?: string; org_value?: string };
    };
  };
  try {
    obj = JSON.parse(raw);
  } catch {
    return {};
  }

  const host = typeof obj.hostname === "string" ? obj.hostname : undefined;
  const req = obj.dns_requirements ?? {};

  const records: FlyCertRecord[] = [];
  const cname = typeof req.cname === "string" ? stripDot(req.cname) : "";
  if (host && cname) {
    records.push({ type: "CNAME", name: host, content: cname });
  } else if (host) {
    // Apex domains can't CNAME — Fly returns A/AAAA addresses instead.
    for (const ip of req.a ?? [])
      if (typeof ip === "string")
        records.push({ type: "A", name: host, content: ip });
    for (const ip of req.aaaa ?? [])
      if (typeof ip === "string")
        records.push({ type: "AAAA", name: host, content: ip });
  }

  const ac = req.acme_challenge;
  const acmeChallenge =
    ac?.name && ac.target
      ? { name: stripDot(ac.name), target: stripDot(ac.target) }
      : undefined;

  const own = req.ownership;
  const ownership =
    own?.name && own.app_value
      ? { name: stripDot(own.name), value: own.app_value }
      : undefined;

  return {
    configured: obj.configured === true,
    status: typeof obj.status === "string" ? obj.status : undefined,
    records,
    acmeChallenge,
    ownership,
  };
}

/**
 * Read a cert's current issuance state — used to poll after the DNS records are
 * in place. Returns null when the status can't be read (so a transient flyctl
 * hiccup during polling isn't mistaken for "issued").
 */
export async function checkFlyCert({
  hostname,
  app,
  cwd,
}: {
  hostname: string;
  app: string;
  cwd: string;
}): Promise<{ configured: boolean; status?: string } | null> {
  const res = await exec({
    cmd: "flyctl",
    args: ["certs", "show", hostname, "-a", app, "--json"],
    cwd,
  });
  if (res.code !== 0) return null;
  try {
    const obj: { configured?: boolean; status?: string } = JSON.parse(
      res.stdout,
    );
    return { configured: obj.configured === true, status: obj.status };
  } catch {
    return null;
  }
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

/**
 * Names of secrets already set at the repo or (with `env`) an environment.
 * Returns null when the list can't be read — callers must not treat that as
 * "no secrets" (e.g. the FLY_API_TOKEN guard would mint a duplicate org token
 * on every run if an auth hiccup read as an empty list).
 */
export async function listGithubSecretNames({
  env,
  repo,
  cwd,
}: {
  env?: string;
  repo?: string | null;
  cwd: string;
}): Promise<Set<string> | null> {
  const args = ["secret", "list", "--json", "name", "-q", ".[].name"];
  if (env) args.push("--env", env);
  if (repo) args.push("--repo", repo);
  const res = await exec({ cmd: "gh", args, cwd });
  if (res.code !== 0) return null;
  return new Set(
    res.stdout
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
    // Environment names may contain spaces/slashes — encode them for the URL.
    args: [
      "api",
      "--method",
      "PUT",
      `/repos/${repo}/environments/${encodeURIComponent(env)}`,
    ],
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
      results.push({
        label: `GitHub environment ${kind}`,
        ok: true,
        detail: "already exists",
      });
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
