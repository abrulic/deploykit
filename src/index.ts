import { resolve } from "node:path";
import { runGenerate } from "./commands/generate.js";
import { runInit } from "./commands/init.js";
import { runRollback } from "./commands/rollback.js";
import type { InitOptions } from "./prompts.js";
import { log, pc } from "./util/log.js";
import { PKG } from "./util/pkg.js";

const HELP = `${pc.bold("deploykit")} — automate CI/CD for Turbo monorepos on Fly.io

${pc.bold("Usage")}
  deploykit init [options]      Detect the monorepo and set everything up
  deploykit generate [options]  Regenerate Dockerfiles/workflow/fly.toml from
                                deploykit.config.ts (overwrites them)
  deploykit rollback [options]  Redeploy a prior image for one environment's Fly
                                app (app only — does not undo DB migrations)

${pc.bold("Options")}
  -y, --yes           Accept detected defaults, no prompts
      --org <slug>    Fly organization slug
      --region <list> Fly region(s), comma-separated; first is primary, the
                      rest are extra stateless regions (default: iad)
      --envs <list>   Environments to configure, comma-separated
                      (preview,staging,production — default: all)
      --dry-run       Detect and print the plan, write nothing
      --provision     Force provisioning in --yes mode (Fly apps, FLY_API_TOKEN,
                      GitHub environments). Interactive runs offer it inline.
      --deploy        Deploy the staging app(s) to Fly at the end of the run.
                      Interactive runs offer it inline; this skips the prompt.
      --pr            Commit generated files on a branch and open a PR
      --force         Overwrite existing generated files instead of skipping
      --cwd <dir>     Run against a different directory
      --app <name>    (rollback) App to roll back (defaults to the sole app)
      --env <kind>    (rollback) Environment: staging or production
      --to <version>  (rollback) Release version to redeploy (non-interactive)
  -h, --help          Show this help
  -v, --version       Show version

${pc.bold("Examples")}
  deploykit init
  deploykit init --yes --org my-org --region iad --dry-run
  deploykit init --yes --org my-org --envs preview,staging
  deploykit rollback --app web --env production
  deploykit rollback --app web --env production --to 41 --yes
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
  const bad = parts.filter((x) => !ENV_KINDS.some((kind) => kind === x));
  if (bad.length) {
    return {
      error: `--envs: unknown environment(s) ${bad.join(", ")} (valid: ${ENV_KINDS.join(", ")})`,
    };
  }
  // Filter the canonical list to narrow to EnvironmentKind[] (and dedupe).
  return { envs: ENV_KINDS.filter((kind) => parts.includes(kind)) };
}

function parseArgs(argv: string[]) {
  const opts: InitOptions = {
    yes: false,
    dryRun: false,
    provision: false,
    deploy: false,
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
      case "--deploy":
        opts.deploy = true;
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
      case "--region": {
        const raw = args[++i];
        if (!raw)
          return {
            command,
            opts,
            help,
            version,
            error: "--region needs a value",
          };
        // Accept a comma-separated list; the first is the primary region and
        // any others become extra (stateless multi-region) regions.
        const list = raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        opts.region = list[0];
        if (list.length > 1) opts.regions = list;
        break;
      }
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
      case "--app":
        opts.app = args[++i];
        if (!opts.app)
          return { command, opts, help, version, error: "--app needs a value" };
        break;
      case "--env": {
        const kind = args[++i];
        if (!kind)
          return { command, opts, help, version, error: "--env needs a value" };
        if (!ENV_KINDS.some((k) => k === kind))
          return {
            command,
            opts,
            help,
            version,
            error: `--env: unknown environment ${kind} (valid: ${ENV_KINDS.join(", ")})`,
          };
        opts.env = kind as (typeof ENV_KINDS)[number];
        break;
      }
      case "--to":
        opts.to = args[++i];
        if (!opts.to)
          return { command, opts, help, version, error: "--to needs a value" };
        break;
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
    case "rollback":
      return runRollback(parsed.opts);
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
