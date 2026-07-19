import * as p from "@clack/prompts";
import { commandExists, exec, execInteractive } from "./util/exec.js";
import { pc } from "./util/log.js";

/** A CLI whose sign-in deploykit can check and drive. */
export interface AuthTool {
  cmd: string;
  /** Human name for messages, e.g. "GitHub". */
  label: string;
  /** Args that exit 0 iff the CLI is already authenticated. */
  statusArgs: string[];
  /** Args that launch the interactive login. */
  loginArgs: string[];
  /** Where to get the CLI when it's missing. */
  installUrl: string;
}

export const GH_TOOL: AuthTool = {
  cmd: "gh",
  label: "GitHub",
  statusArgs: ["auth", "status"],
  loginArgs: ["auth", "login"],
  installUrl: "https://cli.github.com",
};

export const FLY_TOOL: AuthTool = {
  cmd: "flyctl",
  label: "Fly",
  statusArgs: ["auth", "whoami"],
  loginArgs: ["auth", "login"],
  installUrl: "https://fly.io/docs/flyctl/install",
};

/**
 * Seams for the interactive bits, injected so the decision tree is testable
 * without a real terminal. Defaults wire straight to clack + the CLIs.
 */
export interface AuthDeps {
  exists: (cmd: string) => Promise<boolean>;
  confirm: (message: string) => Promise<boolean>;
  runLogin: (tool: AuthTool, cwd: string) => Promise<number>;
  verify: (tool: AuthTool, cwd: string) => Promise<boolean>;
  log: {
    warn: (s: string) => void;
    success: (s: string) => void;
    info: (s: string) => void;
  };
}

const defaultDeps: AuthDeps = {
  exists: commandExists,
  confirm: async (message) =>
    (await p.confirm({ message, initialValue: true })) === true,
  runLogin: (tool, cwd) =>
    execInteractive({ cmd: tool.cmd, args: tool.loginArgs, cwd }),
  verify: async (tool, cwd) =>
    (await exec({ cmd: tool.cmd, args: tool.statusArgs, cwd })).code === 0,
  log: {
    warn: (s) => p.log.warn(s),
    success: (s) => p.log.success(pc.green(s)),
    info: (s) => p.log.info(s),
  },
};

export interface EnsureLoggedInInput {
  tool: AuthTool;
  /** Readiness as already determined by preflight. */
  ready: boolean;
  cwd: string;
  /** Whether we may prompt + drive an interactive login (false under --yes / --dry-run). */
  interactive: boolean;
  deps?: Partial<AuthDeps>;
}

/**
 * Bring a single CLI to an authenticated state, driving its interactive login
 * when we're allowed to prompt. Returns the resulting readiness.
 *
 * Already-ready is a no-op. A missing binary, a non-interactive run, or a
 * declined/failed login all resolve to `false` — callers then degrade to the
 * same warn-and-skip behaviour deploykit had before login was inline.
 */
export async function ensureLoggedIn({
  tool,
  ready,
  cwd,
  interactive,
  deps,
}: EnsureLoggedInInput): Promise<boolean> {
  if (ready) return true;
  const d = { ...defaultDeps, ...deps };
  const loginCmd = `${tool.cmd} ${tool.loginArgs.join(" ")}`;

  if (!(await d.exists(tool.cmd))) {
    d.log.warn(
      `${tool.label} CLI (\`${tool.cmd}\`) isn't installed — install it (${tool.installUrl}) to provision ${tool.label}.`,
    );
    return false;
  }

  // --yes / --dry-run can't drive a browser login: point at the command instead.
  if (!interactive) {
    d.log.warn(
      `${tool.label} (\`${tool.cmd}\`) isn't authenticated — run \`${loginCmd}\` to enable ${tool.label} provisioning.`,
    );
    return false;
  }

  if (
    !(await d.confirm(`Log in to ${tool.label} now? (runs \`${loginCmd}\`)`))
  ) {
    d.log.info(
      `Skipping ${tool.label} login — steps that need it will be skipped.`,
    );
    return false;
  }

  const code = await d.runLogin(tool, cwd);
  if (code !== 0) {
    d.log.warn(
      `${tool.label} login didn't complete — re-run \`deploykit init\` when ready.`,
    );
    return false;
  }

  // Trust the login only if the status check now passes.
  const ok = await d.verify(tool, cwd);
  if (ok) d.log.success(`Logged in to ${tool.label}.`);
  else
    d.log.warn(
      `${tool.label} still looks unauthenticated — skipping its provisioning steps.`,
    );
  return ok;
}

/**
 * Bring GitHub and Fly sign-in up to date before provisioning. Returns the
 * refreshed readiness for both, which the org picker and provisioning steps
 * consume. No-op (returns the inputs) when both are already authenticated.
 */
export async function ensureAuth({
  ghReady,
  flyReady,
  cwd,
  interactive,
  deps,
}: {
  ghReady: boolean;
  flyReady: boolean;
  cwd: string;
  interactive: boolean;
  deps?: Partial<AuthDeps>;
}): Promise<{ ghReady: boolean; flyReady: boolean }> {
  if (ghReady && flyReady) {
    // The "Sign in" phase header is already on screen; fill it so it doesn't
    // read as an empty step when there's nothing to do.
    if (interactive)
      p.log.success(pc.green("Already signed in to GitHub and Fly."));
    return { ghReady, flyReady };
  }
  if (interactive) {
    const need = [!ghReady && "GitHub", !flyReady && "Fly"]
      .filter(Boolean)
      .join(" and ");
    p.note(
      [
        `deploykit connects your ${need} account to provision your deploy.`,
        "It signs you in with the official CLIs using their normal browser",
        "login — the same one you'd run yourself.",
        "",
        `${pc.dim("• Your credentials stay in the GitHub/Fly CLIs — deploykit never sees or stores them.")}`,
        `${pc.dim("• GitHub's page shows your sign-in location; that's their security check, not ours.")}`,
      ].join("\n"),
      "Connect your accounts",
    );
  }
  const gh = await ensureLoggedIn({
    tool: GH_TOOL,
    ready: ghReady,
    cwd,
    interactive,
    deps,
  });
  const fly = await ensureLoggedIn({
    tool: FLY_TOOL,
    ready: flyReady,
    cwd,
    interactive,
    deps,
  });
  return { ghReady: gh, flyReady: fly };
}
