import { resolve } from "node:path";
import { runInit } from "./commands/init.js";
import type { InitOptions } from "./prompts.js";
import { log, pc } from "./util/log.js";

const VERSION = "0.1.0";

const HELP = `${pc.bold("deploykit")} — automate CI/CD for Turbo monorepos on Fly.io

${pc.bold("Usage")}
  deploykit init [options]

${pc.bold("Options")}
  -y, --yes           Accept detected defaults, no prompts
      --org <slug>    Fly organization slug
      --region <code> Fly primary region (default: iad)
      --dry-run       Detect and print the plan, write nothing
      --provision     Create Fly apps + set FLY_API_TOKEN secret (each confirmed)
      --pr            Commit generated files on a branch and open a PR
      --force         Overwrite existing generated files instead of skipping
      --cwd <dir>     Run against a different directory
  -h, --help          Show this help
  -v, --version       Show version

${pc.bold("Examples")}
  deploykit init
  deploykit init --yes --org my-org --region iad --dry-run
`;

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
        if (!opts.org) return { command, opts, help, version, error: "--org needs a value" };
        break;
      case "--region":
        opts.region = args[++i];
        if (!opts.region) return { command, opts, help, version, error: "--region needs a value" };
        break;
      case "--cwd": {
        const dir = args[++i];
        if (!dir) return { command, opts, help, version, error: "--cwd needs a value" };
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
    log.info(VERSION);
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
