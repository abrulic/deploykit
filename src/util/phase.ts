import * as p from "@clack/prompts";
import pc from "picocolors";

/**
 * A running, styled phase header rendered into clack's prompt stream, e.g.
 *
 *     ◇  2/6  Detect ──────────────────────
 *
 * The dim counter gives users a felt sense of progress; the trailing rule
 * makes each phase boundary easy to scan. Everything logged afterwards sits
 * under the header via clack's connecting gutter, so it reads as belonging to
 * that phase.
 */
export interface Phases {
  /** Print the next phase header (auto-incrementing the counter). */
  begin(title: string): void;
}

const RULE_WIDTH = 32;

export function createPhases(total: number): Phases {
  let i = 0;
  return {
    begin(title) {
      i += 1;
      const counter = pc.dim(`${i}/${total}`);
      const rule = pc.dim("─".repeat(Math.max(2, RULE_WIDTH - title.length)));
      p.log.step(`${counter}  ${pc.bold(title)} ${rule}`);
    },
  };
}

/** Options that determine which phases a run actually goes through. */
export interface PhasePlanInput {
  yes: boolean;
  dryRun: boolean;
  provision: boolean;
  deploy: boolean;
  pr: boolean;
}

/**
 * The phases `deploykit init` will run, in order, for the given options — used
 * to size the "i/N" counter so it matches what the user actually sees. Mirrors
 * the branch structure of `runInit`; keep the two in sync.
 */
export function plannedPhases(opts: PhasePlanInput): string[] {
  const interactive = !opts.yes && !opts.dryRun;
  const list = ["Preflight", "Detect"];
  if (interactive) list.push("Sign in");
  list.push("Configure", "Plan");
  if (opts.dryRun) return list;
  list.push("Generate");
  const provisioned = !opts.yes || opts.provision;
  if (provisioned) list.push("Provision");
  if (provisioned && (interactive || opts.deploy)) list.push("Deploy");
  if (opts.pr) list.push("Open PR");
  return list;
}
