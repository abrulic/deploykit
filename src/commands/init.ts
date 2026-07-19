import * as p from "@clack/prompts";
import { ensureAuth } from "../auth.js";
import type { DeploykitConfig } from "../config.js";
import { firstDeploy } from "../deploy.js";
import { detect } from "../detect.js";
import { planFiles, writeFiles } from "../generate/index.js";
import {
  flyAppNames,
  mergeSecretTargets,
  renderPlan,
  type SecretTarget,
  secretNames,
  secretTargets,
} from "../plan.js";
import { openPr } from "../pr.js";
import { preflight } from "../preflight.js";
import { buildConfig, type InitOptions } from "../prompts.js";
import {
  createFlyApps,
  createFlyOrgToken,
  createGithubEnvironments,
  ensureGithubEnvironment,
  getRepo,
  listFlyApps,
  listGithubEnvironments,
  listGithubSecretNames,
  type StepResult,
  setGithubSecret,
} from "../provision.js";
import {
  awaitCertIssuance,
  domainTargets,
  provisionCloudflare,
} from "../provision-cloudflare.js";
import { type SecretGroup, saveSecretsFile } from "../secrets-file.js";
import { pc } from "../util/log.js";

/** Accumulates plaintext secret values set during a run for optional local export. */
type SecretCapture = (label: string, name: string, value: string) => void;

/**
 * Palette of distinct colors, assigned to secret targets by position. Keeping
 * it positional (rather than keyed by a fixed set of environment names) means
 * any environments a user has on their repo — however many, whatever named —
 * each get their own color so the sections are easy to tell apart. Cycles if
 * there are more targets than colors.
 */
const envPalette: Array<(s: string) => string> = [
  pc.cyan,
  pc.magenta,
  pc.yellow,
  pc.blue,
  pc.green,
];

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
  for (const w of detection.warnings) p.log.warn(w);

  // ── Phase 1.5: sign in ──
  // Bring GitHub/Fly auth up to date before we ask anything — a successful Fly
  // login unlocks the org picker below. Interactive login is skipped under --yes
  // / --dry-run (both fall back to a warning pointing at the login command).
  const interactive = !opts.yes && !opts.dryRun;
  const { ghReady, flyReady } = await ensureAuth({
    ghReady: pre.ghReady,
    flyReady: pre.flyReady,
    cwd: opts.cwd,
    interactive,
  });

  // ── Phase 2: ask ──
  // The Cloudflare step resolves its own token (env → .deploykit/credentials →
  // prompt) and exports it, so the provisioning phase below picks it up.
  const config = await buildConfig({ detection, opts, flyReady });
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
  const provisioned = !opts.yes || opts.provision;
  let captured = new Map<string, { name: string; value: string }[]>();
  if (provisioned) {
    captured = await runProvisioning({ config, opts, flyReady, ghReady });
  }

  // ── Phase 5.5: first deploy ──
  // Boot the staging app(s) now so init can end on a live URL. Only after
  // provisioning (which creates the apps + secrets), and only when we can
  // prompt or the user explicitly opted in with --deploy. Runs before the PR
  // step, which moves the generated files onto a branch and off the work tree.
  if (provisioned && (interactive || opts.deploy)) {
    await firstDeploy({
      config,
      cwd: opts.cwd,
      flyReady,
      assumeYes: opts.deploy,
      captured: captured.get("staging") ?? [],
    });
  }

  // ── Phase 6: PR ──
  if (opts.pr) await maybeOpenPr({ opts, written, ghReady });

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
    p.log.warn(
      "Couldn't resolve the GitHub repo (gh repo view) — skipping GitHub steps.",
    );
  }

  await provisionFlyApps({ config, opts, flyReady });
  // Cloudflare certs need the Fly apps to exist first, so this runs after.
  await provisionCloudflareStep({ config, opts, flyReady });
  if (flyReady && repo)
    await provisionFlyToken({ config, opts, repo, capture });
  if (repo) await provisionEnvironments({ config, opts, repo });
  if (repo) await provisionSecrets({ config, opts, repo, capture });

  await maybeSaveSecrets({ opts, captured });
  return captured;
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
    p.log.warn(
      "Skipping Cloudflare — flyctl isn't authenticated (needed to issue Fly certs).",
    );
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
  reportSteps(results);

  // Records are in place; now wait for Fly to actually issue the certs so we
  // don't end on "done" while HTTPS is still 526-ing under strict SSL.
  const c = p.spinner();
  c.start("Waiting for Fly to issue certificates (a couple of minutes)");
  const certs = await awaitCertIssuance({ config, cwd: opts.cwd });
  const anyPending = certs.some((r) => r.detail);
  c.stop(
    anyPending
      ? pc.yellow("Some certificates are still validating")
      : pc.green("Certificates issued"),
  );
  reportSteps(certs);
}

/** Print a list of provisioning steps: errors red, notes dimmed, clean green. */
function reportSteps(results: StepResult[]) {
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
  const missing = existing
    ? wanted.filter((n) => !existing.includes(n))
    : wanted;
  if (existing && missing.length === 0) {
    p.log.info(`Fly apps already exist — skipping (${wanted.join(", ")}).`);
    return;
  }
  if (
    !(await confirm({
      opts,
      message: `Create Fly app(s) (${missing.join(", ")})?`,
    }))
  )
    return;

  const s = p.spinner();
  s.start("Creating Fly apps");
  report({
    spinner: s,
    results: await createFlyApps({
      names: missing,
      org: config.provider.org,
      cwd: opts.cwd,
    }),
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
  if (existing === null) {
    // Can't tell whether the token exists — creating one anyway would mint a
    // fresh long-lived org token on every run with a flaky `gh`.
    p.log.warn(
      "Couldn't read the repo's secrets (gh secret list) — skipping Fly token creation.",
    );
    return;
  }
  if (existing.has("FLY_API_TOKEN")) {
    p.log.info("FLY_API_TOKEN already set — skipping (delete it to rotate).");
    return;
  }
  if (
    !(await confirm({
      opts,
      message: "Create a Fly deploy token and set FLY_API_TOKEN?",
    }))
  ) {
    return;
  }

  const s = p.spinner();
  s.start("Creating Fly deploy token");
  const tok = await createFlyOrgToken({
    org: config.provider.org,
    cwd: opts.cwd,
  });
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
      ? pc.green(
          "✔ Created Fly deploy token (visible under Fly → Tokens) + set FLY_API_TOKEN",
        )
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
  if (Object.values(config.apps).some((a) => a.environments.staging))
    kinds.push("staging");
  if (Object.values(config.apps).some((a) => a.environments.production))
    kinds.push("production");
  if (kinds.length === 0) return;

  const existing = new Set(
    (await listGithubEnvironments({ repo, cwd: opts.cwd })) ?? [],
  );
  const missing = kinds.filter((k) => !existing.has(k));
  if (missing.length === 0) {
    p.log.info(
      `GitHub environments already exist — skipping (${kinds.join(", ")}).`,
    );
    return;
  }
  if (
    !(await confirm({
      opts,
      message: `Create GitHub environment(s) (${missing.join(", ")})?`,
    }))
  ) {
    return;
  }

  const s = p.spinner();
  s.start("Creating environments");
  // createGithubEnvironments is idempotent — it re-skips any that now exist.
  report({
    spinner: s,
    results: await createGithubEnvironments({ config, cwd: opts.cwd }),
  });
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

  const groups: SecretGroup[] = [...captured.entries()].map(
    ([label, entries]) => ({
      label,
      entries,
    }),
  );
  const res = saveSecretsFile({ cwd: opts.cwd, groups });
  p.log.success(pc.green(`Wrote ${res.path} ${pc.dim("(chmod 600)")}`));
  if (!res.gitignored) {
    p.log.warn(
      `Couldn't update .gitignore automatically — add ${res.path} yourself.`,
    );
  }
  p.note(
    `Plaintext copies live in ${pc.bold(res.path)}.\nMove them into 1Password / your secret manager, then delete the file.`,
    "Local secrets",
  );
}

/**
 * Decide which environments to set secrets for. When the repo has environments
 * beyond the ones deploykit configured, prompt a multiselect so the user can
 * opt those in (deploykit's own are pre-checked; discovered ones are hinted and
 * left unchecked). With nothing extra, just return the candidates unchanged.
 * Returns null if the user cancels the selection.
 */
async function selectSecretTargets({
  candidates,
  opts,
}: {
  candidates: SecretTarget[];
  opts: InitOptions;
}): Promise<SecretTarget[] | null> {
  const hasDiscovered = candidates.some((t) => !t.kind);
  if (!hasDiscovered || opts.yes) return candidates;

  const selected = await p.multiselect({
    message: "Set app secrets for which environments?",
    options: candidates.map((t) => ({
      value: t.label,
      label: t.env ?? t.label,
      hint: t.kind ? undefined : "existing on your repo",
    })),
    initialValues: candidates.filter((t) => t.kind).map((t) => t.label),
    required: false,
  });
  if (p.isCancel(selected)) return null;
  const chosen = new Set(selected);
  return candidates.filter((t) => chosen.has(t.label));
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

  const configTargets = secretTargets(config);
  if (configTargets.length === 0) return;

  // Environments deploykit models aren't the whole story — the repo may have
  // others the user created (named anything). Fold those in so secrets can be
  // set for them too; if there are any, let the user pick which to target.
  const ghEnvs = await listGithubEnvironments({ repo, cwd: opts.cwd });
  const candidates = mergeSecretTargets({ configTargets, ghEnvs });
  const targets = await selectSecretTargets({ candidates, opts });
  if (targets === null) return; // cancelled
  if (targets.length === 0) return;

  // What's already set per target, so we only prompt for what's missing. An
  // unreadable list (null) is treated as empty: for env-scoped targets that's
  // the normal first run (the environment doesn't exist yet), and re-setting a
  // secret is idempotent — unlike the token step, prompting again is harmless.
  const existingByLabel = new Map<string, Set<string>>();
  for (const t of targets) {
    const names = await listGithubSecretNames({
      env: t.env,
      repo,
      cwd: opts.cwd,
    });
    existingByLabel.set(t.label, names ?? new Set());
  }
  const missingCount = targets.reduce(
    (n, t) =>
      n + names.filter((nm) => !existingByLabel.get(t.label)?.has(nm)).length,
    0,
  );
  if (missingCount === 0) {
    p.log.info(
      "App secrets already set for the selected environments — skipping.",
    );
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

  const multiEnv = targets.length > 1;
  for (const [i, target] of targets.entries()) {
    const color = envPalette[i % envPalette.length] ?? pc.cyan;
    // Prefer the real GitHub environment name (which can be anything the user
    // set up); fall back to the label for repo-level targets that have no env.
    const title = target.env ?? target.kind ?? target.label;
    const scope = target.env
      ? `environment: ${target.env}`
      : "repository-level";
    // Flag targets deploykit didn't configure so it's clear they came from the repo.
    const discovered = !target.kind ? pc.dim(" · existing on repo") : "";
    const existing = existingByLabel.get(target.label) ?? new Set<string>();
    const toSet = names.filter((nm) => !existing.has(nm));
    if (toSet.length === 0) {
      p.log.info(
        `${color(pc.bold(title))} ${pc.dim(`(${scope})`)} — all secrets already set, skipping.`,
      );
      continue;
    }
    // A colored, bold section header per environment so that when several
    // environments are set up in one run each block is easy to tell apart.
    const header = `${color(pc.bold(title.toUpperCase()))} secrets ${pc.dim(
      `(${scope}) · ${toSet.length} to set`,
    )}${discovered}`;
    if (multiEnv) p.log.message(color("─".repeat(28)));
    p.log.step(header);
    // Env-scoped secrets require the environment to exist first.
    if (target.env) {
      await ensureGithubEnvironment({ env: target.env, repo, cwd: opts.cwd });
    }
    for (const name of toSet) {
      const value = await p.password({
        message: `${pc.bold(name)} ${color(`· ${title}`)} ${pc.dim("(blank to skip)")}`,
      });
      if (p.isCancel(value)) {
        p.log.warn("Stopped setting secrets.");
        return;
      }
      if (!value.trim()) {
        p.log.warn(`skipped ${name} ${color(`(${title})`)}`);
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
        p.log.success(color(res.label));
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
  if (!(await confirm({ opts, message: "Commit files and open a PR?" })))
    return;

  const s = p.spinner();
  s.start("Opening pull request");
  const res = await openPr({ cwd: opts.cwd, paths: written });
  s.stop(
    res.ok
      ? pc.green(`PR opened: ${res.url}`)
      : pc.red(`PR failed: ${res.detail}`),
  );
  if (res.restoredTo) {
    p.log.info(
      `Back on ${pc.bold(res.restoredTo)} — the generated files live on the PR branch.`,
    );
  }
}

function report({
  spinner,
  results,
}: {
  spinner: Spinner;
  results: StepResult[];
}) {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    spinner.stop(pc.green(results.map((r) => `✔ ${r.label}`).join("  ")));
    return;
  }
  spinner.stop(pc.yellow("Some steps had issues:"));
  for (const r of results) {
    if (r.ok)
      p.log.success(r.label + (r.detail ? pc.dim(` (${r.detail})`) : ""));
    else p.log.error(`${r.label}: ${r.detail ?? "failed"}`);
  }
}

/** In --yes mode every confirm auto-accepts; otherwise prompt. */
async function confirm({
  opts,
  message,
}: {
  opts: InitOptions;
  message: string;
}) {
  if (opts.yes) return true;
  const res = await p.confirm({ message });
  return res === true;
}

function nextSteps({
  config,
  opts,
}: {
  config: DeploykitConfig;
  opts: InitOptions;
}) {
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
    lines.push(
      pc.dim(
        "  • Anything you skipped above can be re-run with `deploykit init`.",
      ),
    );
  }
  // The environment alone doesn't gate anything — the approval prompt only
  // appears once reviewers are configured, which needs a human choice.
  if (Object.values(config.apps).some((a) => a.environments.production)) {
    lines.push(
      "  • Add required reviewers to the GitHub `production` environment (Settings → Environments) to gate production deploys.",
    );
  }
  if (!opts.pr) lines.push("  • Commit the generated files and open a PR.");
  lines.push(
    "  • Open a pull request to get your first preview environment 🚀",
  );
  return lines.join("\n");
}
