import * as p from "@clack/prompts";
import type { DeploykitConfig } from "../config.js";
import { detect } from "../detect.js";
import { planFiles, writeFiles } from "../generate/index.js";
import { flyAppNames, renderPlan, secretNames, secretTargets } from "../plan.js";
import { preflight } from "../preflight.js";
import { openPr } from "../pr.js";
import {
  createFlyApps,
  createFlyOrgToken,
  createGithubEnvironments,
  ensureGithubEnvironment,
  getRepo,
  listFlyApps,
  listGithubEnvironments,
  listGithubSecretNames,
  setGithubSecret,
  type StepResult,
} from "../provision.js";
import { provisionCloudflare, domainTargets } from "../provision-cloudflare.js";
import { buildConfig, type InitOptions } from "../prompts.js";
import { saveSecretsFile, type SecretGroup } from "../secrets-file.js";
import { pc } from "../util/log.js";

/** Accumulates plaintext secret values set during a run for optional local export. */
type SecretCapture = (label: string, name: string, value: string) => void;

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
  const config = await buildConfig({
    detection,
    opts,
    flyReady: pre.flyReady,
    cfReady: pre.cfReady,
  });
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
  // Offered inline whenever the CLIs are authenticated. In non-interactive
  // mode (--yes) we keep the old gate and only provision under --provision,
  // since we can't prompt for secret values there.
  if (!opts.yes || opts.provision) {
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
  // Plaintext values set this run, grouped by section, offered as a local
  // export at the end so the user can archive them (e.g. into 1Password).
  const captured = new Map<string, { name: string; value: string }[]>();
  const capture: SecretCapture = (label, name, value) => {
    const entries = captured.get(label) ?? [];
    entries.push({ name, value });
    captured.set(label, entries);
  };

  // Resolve the repo once — needed for token, environments, and secrets.
  const repo = ghReady ? await getRepo(opts.cwd) : null;
  if (ghReady && !repo) {
    p.log.warn("Couldn't resolve the GitHub repo (gh repo view) — skipping GitHub steps.");
  }

  await provisionFlyApps({ config, opts, flyReady });
  // Cloudflare certs need the Fly apps to exist first, so this runs after.
  await provisionCloudflareStep({ config, opts, flyReady });
  if (flyReady && repo) await provisionFlyToken({ config, opts, repo, capture });
  if (repo) await provisionEnvironments({ config, opts, repo });
  if (repo) await provisionSecrets({ config, opts, repo, capture });

  await maybeSaveSecrets({ opts, captured });
}

/**
 * Verify the Cloudflare zone, issue Fly certs for each custom hostname, and
 * wire the DNS records + zone settings. No-op unless the config has a
 * `cloudflare` block; skips (with a warning) without a token or flyctl auth.
 */
async function provisionCloudflareStep({
  config,
  opts,
  flyReady,
}: {
  config: DeploykitConfig;
  opts: InitOptions;
  flyReady: boolean;
}) {
  const cf = config.cloudflare;
  if (!cf) return;

  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) {
    p.log.warn("Skipping Cloudflare — CLOUDFLARE_API_TOKEN is not set.");
    return;
  }
  if (!flyReady) {
    p.log.warn("Skipping Cloudflare — flyctl isn't authenticated (needed to issue Fly certs).");
    return;
  }
  const targets = domainTargets(config);
  if (targets.length === 0) return;

  if (
    !(await confirm({
      opts,
      message: `Wire ${targets.length} custom domain(s) through Cloudflare (zone ${cf.zone})?`,
    }))
  ) {
    return;
  }

  const s = p.spinner();
  s.start("Provisioning Cloudflare (certs, DNS, settings)");
  const results = await provisionCloudflare({ config, token, cwd: opts.cwd });
  const failed = results.filter((r) => !r.ok);
  s.stop(
    failed.length
      ? pc.yellow("Cloudflare — some steps need attention:")
      : pc.green("Cloudflare configured"),
  );
  for (const r of results) {
    if (!r.ok) p.log.error(`${r.label}: ${r.detail ?? "failed"}`);
    else if (r.detail) p.log.warn(`${r.label} ${pc.dim(`(${r.detail})`)}`);
    else p.log.success(pc.green(r.label));
  }
}

/** Create the staging/production Fly apps that don't exist yet. */
async function provisionFlyApps({
  config,
  opts,
  flyReady,
}: {
  config: DeploykitConfig;
  opts: InitOptions;
  flyReady: boolean;
}) {
  if (!flyReady) {
    p.log.warn("Skipping Fly provisioning — `flyctl` is not authenticated.");
    return;
  }
  const wanted = flyAppNames(config);
  if (wanted.length === 0) return;

  const existing = await listFlyApps(opts.cwd);
  const missing = existing ? wanted.filter((n) => !existing.includes(n)) : wanted;
  if (existing && missing.length === 0) {
    p.log.info(`Fly apps already exist — skipping (${wanted.join(", ")}).`);
    return;
  }
  if (!(await confirm({ opts, message: `Create Fly app(s) (${missing.join(", ")})?` }))) return;

  const s = p.spinner();
  s.start("Creating Fly apps");
  report({
    spinner: s,
    results: await createFlyApps({ names: missing, org: config.provider.org, cwd: opts.cwd }),
  });
}

/**
 * Create an org-scoped Fly deploy token and store it as FLY_API_TOKEN. Skipped
 * if the secret already exists, so re-runs don't mint duplicate tokens.
 */
async function provisionFlyToken({
  config,
  opts,
  repo,
  capture,
}: {
  config: DeploykitConfig;
  opts: InitOptions;
  repo: string;
  capture: SecretCapture;
}) {
  const existing = await listGithubSecretNames({ repo, cwd: opts.cwd });
  if (existing.has("FLY_API_TOKEN")) {
    p.log.info("FLY_API_TOKEN already set — skipping (delete it to rotate).");
    return;
  }
  if (!(await confirm({ opts, message: "Create a Fly deploy token and set FLY_API_TOKEN?" }))) {
    return;
  }

  const s = p.spinner();
  s.start("Creating Fly deploy token");
  const tok = await createFlyOrgToken({ org: config.provider.org, cwd: opts.cwd });
  if (!tok.ok || !tok.token) {
    s.stop(pc.red(`Fly token: ${tok.detail ?? "failed"}`));
    return;
  }
  const res = await setGithubSecret({
    name: "FLY_API_TOKEN",
    value: tok.token,
    repo,
    cwd: opts.cwd,
  });
  s.stop(
    res.ok
      ? pc.green("✔ Created Fly deploy token (visible under Fly → Tokens) + set FLY_API_TOKEN")
      : pc.red(`FLY_API_TOKEN: ${res.detail ?? "failed"}`),
  );
  if (res.ok) capture("Fly", "FLY_API_TOKEN", tok.token);
}

/** Create the GitHub deployment environments that don't exist yet. */
async function provisionEnvironments({
  config,
  opts,
  repo,
}: {
  config: DeploykitConfig;
  opts: InitOptions;
  repo: string;
}) {
  const kinds: string[] = [];
  if (Object.values(config.apps).some((a) => a.environments.staging)) kinds.push("staging");
  if (Object.values(config.apps).some((a) => a.environments.production)) kinds.push("production");
  if (kinds.length === 0) return;

  const existing = new Set((await listGithubEnvironments({ repo, cwd: opts.cwd })) ?? []);
  const missing = kinds.filter((k) => !existing.has(k));
  if (missing.length === 0) {
    p.log.info(`GitHub environments already exist — skipping (${kinds.join(", ")}).`);
    return;
  }
  if (!(await confirm({ opts, message: `Create GitHub environment(s) (${missing.join(", ")})?` }))) {
    return;
  }

  const s = p.spinner();
  s.start("Creating environments");
  // createGithubEnvironments is idempotent — it re-skips any that now exist.
  report({ spinner: s, results: await createGithubEnvironments({ config, cwd: opts.cwd }) });
}

/**
 * Offer to write the secrets set this run to a gitignored, 0600 local file.
 * Useful for the FLY_API_TOKEN in particular — it's machine-generated, so this
 * is the only place the user can capture it for a password manager.
 */
async function maybeSaveSecrets({
  opts,
  captured,
}: {
  opts: InitOptions;
  captured: Map<string, { name: string; value: string }[]>;
}) {
  if (opts.yes || captured.size === 0) return;

  const count = [...captured.values()].reduce((n, e) => n + e.length, 0);
  if (
    !(await confirm({
      opts,
      message: `Save a local plaintext copy of the ${count} secret(s) set this run? (gitignored)`,
    }))
  ) {
    return;
  }

  const groups: SecretGroup[] = [...captured.entries()].map(([label, entries]) => ({
    label,
    entries,
  }));
  const res = saveSecretsFile({ cwd: opts.cwd, groups });
  p.log.success(pc.green(`Wrote ${res.path} ${pc.dim("(chmod 600)")}`));
  if (!res.gitignored) {
    p.log.warn(`Couldn't update .gitignore automatically — add ${res.path} yourself.`);
  }
  p.note(
    `Plaintext copies live in ${pc.bold(res.path)}.\nMove them into 1Password / your secret manager, then delete the file.`,
    "Local secrets",
  );
}

/**
 * Offer to set each app's detected env vars as GitHub secrets, scoped to the
 * environments the user selected. Values are prompted (masked) per environment
 * since staging and production usually differ; blank input skips that secret.
 * Already-set secrets are skipped with an info line, so re-runs only ask for
 * what's missing. Skipped in --yes mode — no way to collect values there.
 */
async function provisionSecrets({
  config,
  opts,
  repo,
  capture,
}: {
  config: DeploykitConfig;
  opts: InitOptions;
  repo: string;
  capture: SecretCapture;
}) {
  if (opts.yes) return;

  const names = secretNames(config);
  if (names.length === 0) return;

  const targets = secretTargets(config);
  if (targets.length === 0) return;

  // What's already set per target, so we only prompt for what's missing.
  const existingByLabel = new Map<string, Set<string>>();
  for (const t of targets) {
    existingByLabel.set(t.label, await listGithubSecretNames({ env: t.env, repo, cwd: opts.cwd }));
  }
  const missingCount = targets.reduce(
    (n, t) => n + names.filter((nm) => !existingByLabel.get(t.label)!.has(nm)).length,
    0,
  );
  if (missingCount === 0) {
    p.log.info("App secrets already set for the selected environments — skipping.");
    return;
  }

  if (
    !(await confirm({
      opts,
      message: `Set ${missingCount} missing secret(s)? (already-set ones are skipped)`,
    }))
  ) {
    return;
  }

  for (const target of targets) {
    const existing = existingByLabel.get(target.label)!;
    const toSet = names.filter((nm) => !existing.has(nm));
    if (toSet.length === 0) {
      p.log.info(`${target.kind}: all secrets already set — skipping.`);
      continue;
    }
    p.log.step(
      target.env
        ? `Secrets for ${pc.bold(target.kind)} ${pc.dim(`(environment: ${target.env})`)}`
        : `Secrets for ${pc.bold(target.kind)} ${pc.dim("(repository-level)")}`,
    );
    // Env-scoped secrets require the environment to exist first.
    if (target.env) {
      await ensureGithubEnvironment({ env: target.env, repo, cwd: opts.cwd });
    }
    for (const name of toSet) {
      const value = await p.password({
        message: `${name} ${pc.dim(`— ${target.kind}`)} (blank to skip)`,
      });
      if (p.isCancel(value)) {
        p.log.warn("Stopped setting secrets.");
        return;
      }
      if (!value.trim()) {
        p.log.warn(`skipped ${name} (${target.kind})`);
        continue;
      }
      const res = await setGithubSecret({
        name,
        value,
        env: target.env,
        repo,
        cwd: opts.cwd,
      });
      if (res.ok) {
        p.log.success(pc.green(res.label));
        capture(target.label, name, value);
      } else {
        p.log.error(`${res.label}: ${res.detail ?? "failed"}`);
      }
    }
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
  // Interactive runs already offered provisioning inline; only print the manual
  // fallback when nothing was offered (--yes without --provision).
  const provisioningOffered = !opts.yes || opts.provision;
  if (!provisioningOffered) {
    lines.push(
      `  • Create a Fly deploy token + set it: flyctl tokens create org --org ${config.provider.org} | gh secret set FLY_API_TOKEN`,
    );
    lines.push(`  • Create Fly apps: ${flyAppNames(config).join(", ")}`);
  } else {
    lines.push(pc.dim("  • Anything you skipped above can be re-run with `deploykit init`."));
  }
  if (!opts.pr) lines.push("  • Commit the generated files and open a PR.");
  lines.push("  • Open a pull request to get your first preview environment 🚀");
  return lines.join("\n");
}
