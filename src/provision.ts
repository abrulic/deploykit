import type { DeploykitConfig } from "./config.js";
import { exec, tryExec } from "./util/exec.js";
import { flyAppNames } from "./plan.js";

export interface StepResult {
  label: string;
  ok: boolean;
  detail?: string;
}

/** Store the Fly deploy token as the FLY_API_TOKEN GitHub Actions secret. */
export async function setFlyTokenSecret(cwd: string) {
  const token = await tryExec({ cmd: "flyctl", args: ["auth", "token"], cwd });
  if (!token) {
    return {
      label: "Set FLY_API_TOKEN secret",
      ok: false,
      detail: "could not read `flyctl auth token`",
    } satisfies StepResult;
  }
  const res = await exec({
    cmd: "gh",
    args: ["secret", "set", "FLY_API_TOKEN", "--body", token],
    cwd,
  });
  return {
    label: "Set FLY_API_TOKEN secret",
    ok: res.code === 0,
    detail: res.code === 0 ? undefined : res.stderr.trim(),
  } satisfies StepResult;
}

/** Create the long-lived Fly apps (staging/production). Previews are lazy. */
export async function createFlyApps({
  config,
  cwd,
}: {
  config: DeploykitConfig;
  cwd: string;
}) {
  const results: StepResult[] = [];
  for (const name of flyAppNames(config)) {
    const res = await exec({
      cmd: "flyctl",
      args: ["apps", "create", name, "--org", config.provider.org],
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

/** Create GitHub deployment environments so staging/production gates work. */
export async function createGithubEnvironments({
  config,
  cwd,
}: {
  config: DeploykitConfig;
  cwd: string;
}) {
  const repo = await tryExec({
    cmd: "gh",
    args: ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    cwd,
  });
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

  const results: StepResult[] = [];
  for (const kind of kinds) {
    const res = await exec({
      cmd: "gh",
      args: ["api", "--method", "PUT", `/repos/${repo}/environments/${kind}`],
      cwd,
    });
    results.push({
      label: `Create GitHub environment ${kind}`,
      ok: res.code === 0,
      detail: res.code === 0 ? undefined : res.stderr.trim(),
    });
  }
  return results;
}
