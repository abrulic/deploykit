import * as p from "@clack/prompts";
import type { DeploykitConfig } from "../config.js";
import { detect } from "../detect.js";
import { planFiles, writeFiles } from "../generate/index.js";
import { flyAppNames, renderPlan } from "../plan.js";
import { preflight } from "../preflight.js";
import { openPr } from "../pr.js";
import {
  createFlyApps,
  createGithubEnvironments,
  setFlyTokenSecret,
  type StepResult,
} from "../provision.js";
import { buildConfig, type InitOptions } from "../prompts.js";
import { pc } from "../util/log.js";

type Spinner = ReturnType<typeof p.spinner>;

export async function runInit(opts: InitOptions) {
  p.intro(pc.bgCyan(pc.black(" deploykit ")));

  // ── Phase 0: preflight ──
  const pre = await preflight(opts.cwd);
  for (const w of pre.warnings) p.log.warn(w);
  if (!pre.ok) {
    for (const e of pre.errors) p.log.error(e);
    p.outro(pc.red("Preflight failed."));
    return 1;
  }

  // ── Phase 1: detect ──
  const detection = detect(opts.cwd);
  const deployable = detection.apps.filter((a) => a.deployable);
  if (deployable.length === 0) {
    p.log.error("No deployable apps found in this workspace.");
    p.outro(pc.red("Nothing to do."));
    return 1;
  }
  p.log.step(
    `Detected ${pc.bold(detection.tool)} · ${detection.packageManager} · Node ${detection.nodeVersion} · ${deployable.length} app(s)`,
  );

  // ── Phase 2: ask ──
  const config = await buildConfig({ detection, opts });
  if (!config) return 1; // cancelled or missing org

  // ── Phase 3: plan ──
  const files = planFiles({ config, cwd: opts.cwd });
  p.note(renderPlan({ config, files, opts }), "Plan");

  if (opts.dryRun) {
    p.outro(pc.dim("Dry run complete — no files written."));
    return 0;
  }

  if (!(await confirm({ opts, message: "Write these files?" }))) {
    p.cancel("Aborted.");
    return 1;
  }

  // ── Phase 4: emit ──
  const { written, skipped } = writeFiles({
    files,
    cwd: opts.cwd,
    force: opts.force,
  });
  for (const f of written) p.log.success(pc.green(`wrote ${f}`));
  for (const f of skipped) p.log.warn(`skipped existing ${f}`);

  // ── Phase 5: provision ──
  if (opts.provision) {
    await runProvisioning({
      config,
      opts,
      flyReady: pre.flyReady,
      ghReady: pre.ghReady,
    });
  }

  // ── Phase 6: PR ──
  if (opts.pr) await maybeOpenPr({ opts, written, ghReady: pre.ghReady });

  p.outro(nextSteps({ config, opts }));
  return 0;
}

interface RunProvisioningInput {
  config: DeploykitConfig;
  opts: InitOptions;
  flyReady: boolean;
  ghReady: boolean;
}

async function runProvisioning({
  config,
  opts,
  flyReady,
  ghReady,
}: RunProvisioningInput) {
  if (!flyReady) {
    p.log.warn("Skipping Fly provisioning — `flyctl` is not authenticated.");
  } else if (
    await confirm({ opts, message: `Create Fly apps (${flyAppNames(config).join(", ")})?` })
  ) {
    const s = p.spinner();
    s.start("Creating Fly apps");
    report({ spinner: s, results: await createFlyApps({ config, cwd: opts.cwd }) });
  }

  if (
    flyReady &&
    ghReady &&
    (await confirm({ opts, message: "Set FLY_API_TOKEN GitHub secret?" }))
  ) {
    const s = p.spinner();
    s.start("Setting secret");
    report({ spinner: s, results: [await setFlyTokenSecret(opts.cwd)] });
  }

  if (
    ghReady &&
    (await confirm({ opts, message: "Create GitHub environments (staging/production)?" }))
  ) {
    const s = p.spinner();
    s.start("Creating environments");
    report({
      spinner: s,
      results: await createGithubEnvironments({ config, cwd: opts.cwd }),
    });
  }
}

async function maybeOpenPr({
  opts,
  written,
  ghReady,
}: {
  opts: InitOptions;
  written: string[];
  ghReady: boolean;
}) {
  if (!ghReady) {
    p.log.warn("Skipping PR — `gh` is not authenticated.");
    return;
  }
  if (written.length === 0) {
    p.log.warn("Skipping PR — no files were written.");
    return;
  }
  if (!(await confirm({ opts, message: "Commit files and open a PR?" }))) return;

  const s = p.spinner();
  s.start("Opening pull request");
  const res = await openPr({ cwd: opts.cwd, paths: written });
  s.stop(res.ok ? pc.green(`PR opened: ${res.url}`) : pc.red(`PR failed: ${res.detail}`));
}

function report({ spinner, results }: { spinner: Spinner; results: StepResult[] }) {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    spinner.stop(pc.green(results.map((r) => `✔ ${r.label}`).join("  ")));
    return;
  }
  spinner.stop(pc.yellow("Some steps had issues:"));
  for (const r of results) {
    if (r.ok) p.log.success(r.label + (r.detail ? pc.dim(` (${r.detail})`) : ""));
    else p.log.error(`${r.label}: ${r.detail ?? "failed"}`);
  }
}

/** In --yes mode every confirm auto-accepts; otherwise prompt. */
async function confirm({ opts, message }: { opts: InitOptions; message: string }) {
  if (opts.yes) return true;
  const res = await p.confirm({ message });
  return res === true;
}

function nextSteps({ config, opts }: { config: DeploykitConfig; opts: InitOptions }) {
  const lines = [pc.bold("Next steps:")];
  if (!opts.provision) {
    lines.push(
      '  • Set the FLY_API_TOKEN secret: gh secret set FLY_API_TOKEN --body "$(fly auth token)"',
    );
    lines.push(`  • Create Fly apps: ${flyAppNames(config).join(", ")}`);
  }
  if (!opts.pr) lines.push("  • Commit the generated files and open a PR.");
  lines.push("  • Open a pull request to get your first preview environment 🚀");
  return lines.join("\n");
}
