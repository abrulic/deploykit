import { tryExec } from "./util/exec.js";

export interface FlyOrg {
  /** Org slug used with `--org`, e.g. "my-org". */
  slug: string;
  /** Human-readable name, e.g. "My Org". Often equal to the slug. */
  name: string;
}

/**
 * List the Fly organizations the authenticated user belongs to.
 *
 * `flyctl orgs list --json` returns a `{ slug: name }` map. Returns null when
 * flyctl is missing, unauthenticated, or the output can't be parsed — callers
 * fall back to asking for a slug by hand.
 */
export async function listFlyOrgs(cwd: string): Promise<FlyOrg[] | null> {
  const out = await tryExec({
    cmd: "flyctl",
    args: ["orgs", "list", "--json"],
    cwd,
  });
  if (!out) return null;
  try {
    const map = JSON.parse(out) as Record<string, string>;
    const orgs = Object.entries(map).map(([slug, name]) => ({ slug, name }));
    return orgs.length ? orgs : null;
  } catch {
    return null;
  }
}
