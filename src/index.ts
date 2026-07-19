import { resolve } from "node:path";
import { runGenerate } from "./commands/generate.js";
import { runInit } from "./commands/init.js";
import type { InitOptions } from "./prompts.js";
import { log, pc } from "./util/log.js";
import { PKG } from "./util/pkg.js";

const HELP = `${pc.bold("deploykit")} — automate CI/CD for Turbo monorepos on Fly.io

${pc.bold("Usage")}
  deploykit init [options]      Detect the monorepo and set everything up
  deploykit generate [options]  Regenerate Dockerfiles/workflow/fly.toml from
                                deploykit.config.ts (overwrites them)

${pc.bold("Options")}
  -y, --yes           Accept detected defaults, no prompts
      --org <slug>    Fly organization slug
      --region <code> Fly primary region (default: iad)
      --envs <list>   Environments to configure, comma-separated
                      (preview,staging,production — default: all)
      --dry-run       Detect and print the plan, write nothing
      --provision     Force provisioning in --yes mode (Fly apps, FLY_API_TOKEN,
                      GitHub environments). Interactive runs offer it inline.
      --pr            Commit generated files on a branch and open a PR
      --force         Overwrite existing generated files instead of skipping
      --cwd <dir>     Run against a different directory
  -h, --help          Show this help
  -v, --version       Show version

${pc.bold("Examples")}
  deploykit init
  deploykit init --yes --org my-org --region iad --dry-run
  deploykit init --yes --org my-org --envs preview,staging
`;

const ENV_KINDS = ["preview", "staging", "production"] as const;

/** Parse `--envs preview,staging` into a validated list, or an error string. */
function parseEnvs(
  raw: string,
): { envs: InitOptions["envs"]; error?: undefined } | { error: string } {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return { error: "--envs needs a value" };
  const bad = parts.filter(
    (x) => !(ENV_KINDS as readonly string[]).includes(x),
  );
  if (bad.length) {
    return {
      error: `--envs: unknown environment(s) ${bad.join(", ")} (valid: ${ENV_KINDS.join(", ")})`,
    };
  }
  return { envs: [...new Set(parts)] as InitOptions["envs"] };
}

function parseArgs(argv: string[]) {
  const opts: InitOptions = {
    yes: false,
    dryRun: false,
    provision: false,
    pr: false,
    force: false,
    cwd: process.cwd(),
  };
  let command = "init";
  let help = false;
  let version = false;

  const args = [...argv];
  // First non-flag token is the command.
  const first = args[0];
  if (first && !first.startsWith("-")) {
    command = first;
    args.shift();
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "-y":
      case "--yes":
        opts.yes = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--provision":
        opts.provision = true;
        break;
      case "--pr":
        opts.pr = true;
        break;
      case "--force":
        opts.force = true;
        break;
      case "--org":
        opts.org = args[++i];
        if (!opts.org)
          return { command, opts, help, version, error: "--org needs a value" };
        break;
      case "--region":
        opts.region = args[++i];
        if (!opts.region)
          return {
            command,
            opts,
            help,
            version,
            error: "--region needs a value",
          };
        break;
      case "--envs": {
        const raw = args[++i];
        if (!raw)
          return {
            command,
            opts,
            help,
            version,
            error: "--envs needs a value",
          };
        const parsed = parseEnvs(raw);
        if (parsed.error !== undefined) {
          return { command, opts, help, version, error: parsed.error };
        }
        opts.envs = parsed.envs;
        break;
      }
      case "--cwd": {
        const dir = args[++i];
        if (!dir)
          return { command, opts, help, version, error: "--cwd needs a value" };
        opts.cwd = resolve(dir);
        break;
      }
      case "-h":
      case "--help":
        help = true;
        break;
      case "-v":
      case "--version":
        version = true;
        break;
      default:
        return { command, opts, help, version, error: `Unknown option: ${a}` };
    }
  }

  return { command, opts, help, version, error: undefined };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.version) {
    log.info(PKG.version);
    return 0;
  }
  if (parsed.help) {
    log.info(HELP);
    return 0;
  }
  if (parsed.error) {
    log.error(parsed.error);
    log.info(HELP);
    return 1;
  }

  switch (parsed.command) {
    case "init":
      return runInit(parsed.opts);
    case "generate":
      return runGenerate(parsed.opts);
    default:
      log.error(`Unknown command: ${parsed.command}`);
      log.info(HELP);
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    log.error(String(err?.stack ?? err));
    process.exitCode = 1;
  });
