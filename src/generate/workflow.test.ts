import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { DeploykitConfig } from "../config.js";
import { sampleConfig, sampleWebApp } from "../testing/fixtures.js";
import { generateWorkflow } from "./workflow.js";

type ParsedWorkflow = {
  env?: Record<string, string>;
  jobs: Record<string, unknown>;
};

describe("generateWorkflow", () => {
  const yaml = generateWorkflow(sampleConfig);
  const doc: ParsedWorkflow = parseYaml(yaml);

  it("produces valid YAML with all job types when every env is used", () => {
    expect(Object.keys(doc.jobs).sort()).toEqual([
      "changes",
      "preview",
      "production",
      "staging",
      "teardown",
    ]);
  });

  it("sets the Fly org from the provider config", () => {
    expect(doc.env?.FLY_ORG).toBe("acme");
  });

  it("builds paths-filter entries per app including internal deps", () => {
    expect(yaml).toContain("packages/ui/**"); // web's internal dep
    expect(yaml).toContain("apps/api/**");
  });

  it("stages each app's secrets via env indirection, guarded against unset values", () => {
    expect(yaml).toContain("SECRET_DATABASE_URL: ${{ secrets.DATABASE_URL }}");
    expect(yaml).toContain('if [ -n "$SECRET_DATABASE_URL" ]');
    expect(yaml).toContain('DATABASE_URL="$SECRET_DATABASE_URL"');
  });

  it("forwards build-time vars as --build-arg instead of runtime secrets", () => {
    expect(yaml).toContain(
      "SECRET_NEXT_PUBLIC_API_URL: ${{ secrets.NEXT_PUBLIC_API_URL }}",
    );
    expect(yaml).toContain(
      'if [ -n "$SECRET_NEXT_PUBLIC_API_URL" ]; then BUILD_ARGS+=(--build-arg "NEXT_PUBLIC_API_URL=$SECRET_NEXT_PUBLIC_API_URL"); fi',
    );
    // Build vars must NOT be staged as Fly runtime secrets — too late to matter.
    expect(yaml).not.toContain(
      'flyctl secrets set --stage --app "$FLY_APP" NEXT_PUBLIC_API_URL',
    );
    // And the deploy command forwards the collected args.
    expect(yaml).toContain('${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}');
  });

  it("never expands a secret expression inside a run script (shell injection)", () => {
    // ${{ secrets.* }} may only appear in env: blocks — GitHub substitutes the
    // raw value into run: scripts, so a value with quotes/$ would execute.
    for (const line of yaml.split("\n")) {
      if (/\$\{\{\s*secrets\./.test(line)) {
        expect(line).toMatch(/^\s+[A-Z_]+: \$\{\{ secrets\.[A-Z0-9_]+ \}\}$/);
      }
    }
  });

  it("uses a bare matrix.app in the production if-guard (no nested expansion)", () => {
    expect(yaml).toContain("github.event.inputs.app == matrix.app");
    expect(yaml).not.toContain("github.event.inputs.app == ${{ matrix.app }}");
  });

  it("offers production apps as a choice input (no free-text typos)", () => {
    const on = (
      doc as unknown as Record<
        string,
        {
          workflow_dispatch: {
            inputs: { app: { type: string; options: string[] } };
          };
        }
      >
    ).on!;
    expect(on.workflow_dispatch.inputs.app.type).toBe("choice");
    expect(on.workflow_dispatch.inputs.app.options).toEqual([
      "all",
      "web",
      "api",
    ]);
  });

  it("upserts the preview comment via a per-app marker", () => {
    expect(yaml).toContain('MARKER="<!-- deploykit-preview:$APP -->"');
    expect(yaml).toContain("--method PATCH"); // update path
    expect(yaml).toContain("gh pr comment"); // create path
  });

  it("only cancels PR runs in-flight; deploy events queue in per-event groups", () => {
    // Event name in the group: a production dispatch must never share (and
    // cancel) the staging-push group; cancellation is limited to PR previews.
    expect(yaml).toContain(
      "group: deploy-${{ github.workflow }}-${{ github.event_name }}-${{ github.ref }}",
    );
    expect(yaml).toContain(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    );
  });

  it("deploys previews/staging single-machine and production with HA", () => {
    const jobs = yaml.split(/^ {2}(?=\w+:)/m);
    const jobText = (name: string) =>
      jobs.find((j) => j.startsWith(`${name}:`))!;
    expect(jobText("preview")).toContain("--ha=false");
    expect(jobText("staging")).toContain("--ha=false");
    expect(jobText("production")).not.toContain("--ha=false");
  });

  it("prefixes every Fly app name the workflow creates or targets", () => {
    const prefixed = generateWorkflow({
      ...sampleConfig,
      namePrefix: "acme-shop",
    });
    expect(prefixed).toContain('FLY_APP="acme-shop-$APP-staging"');
    expect(prefixed).toContain('FLY_APP="acme-shop-$APP-prod"');
    expect(prefixed).toContain(
      'FLY_APP="acme-shop-$APP-pr-${{ github.event.number }}"',
    );
    expect(prefixed).toContain(
      'FLY_APP="acme-shop-${{ matrix.app }}-pr-${{ github.event.number }}"',
    );
    expect(prefixed).toContain(
      'URL="https://acme-shop-$APP-pr-${{ github.event.number }}.fly.dev"',
    );
  });

  it("checks Fly auth before every deploy, with an actionable message", () => {
    // `flyctl apps create` reports a bad token as an opaque GraphQL error about
    // organizations, and the `flyctl status` fallback swallows stderr — so the
    // preflight is what makes an expired FLY_API_TOKEN diagnosable.
    const jobs = yaml.split(/^ {2}(?=\w+:)/m);
    for (const name of ["preview", "staging", "production"]) {
      const job = jobs.find((j) => j.startsWith(`${name}:`));
      expect(job).toContain("flyctl auth whoami");
      expect(job).toContain("FLY_API_TOKEN is missing, invalid, or expired");
      expect(job).toContain("flyctl tokens create org --org $FLY_ORG");
    }
  });

  it("runs the auth check before anything that needs the token", () => {
    expect(yaml.indexOf("flyctl auth whoami")).toBeLessThan(
      yaml.indexOf("flyctl apps create"),
    );
  });

  it("warns instead of failing when a preview teardown can't run", () => {
    // The PR is already closed, so failing the job helps nobody — but a silently
    // swallowed error leaves preview machines running and billing.
    const teardown = yaml
      .split(/^ {2}(?=\w+:)/m)
      .find((j) => j.startsWith("teardown:"));
    expect(teardown).toContain("::warning::could not destroy");
    expect(teardown).not.toContain("|| true");
  });

  it("keeps unprefixed names when no namePrefix is configured (old configs)", () => {
    expect(yaml).toContain('FLY_APP="$APP-staging"');
    expect(yaml).toContain('FLY_APP="$APP-prod"');
  });

  it("omits preview/teardown/production when only staging is configured", () => {
    const stagingOnly: DeploykitConfig = {
      ...sampleConfig,
      apps: {
        web: {
          ...sampleWebApp,
          environments: {
            staging: { name: "web-staging", trigger: "push:main" },
          },
        },
      },
    };
    const parsed: ParsedWorkflow = parseYaml(generateWorkflow(stagingOnly));
    expect(Object.keys(parsed.jobs).sort()).toEqual(["changes", "staging"]);
  });

  it("emits no scale step and is byte-identical when no extra regions are set", () => {
    // A redundant regions list (only the primary) must not change a thing.
    const onlyPrimary: DeploykitConfig = {
      ...sampleConfig,
      provider: { ...sampleConfig.provider, regions: ["iad"] },
    };
    expect(yaml).not.toContain("flyctl scale count");
    expect(generateWorkflow(onlyPrimary)).toBe(yaml);
  });

  it("scales into extra regions for staging/production but not preview", () => {
    const multi: DeploykitConfig = {
      ...sampleConfig,
      provider: { ...sampleConfig.provider, regions: ["iad", "lhr", "fra"] },
    };
    const out = generateWorkflow(multi);
    // Still valid YAML with the scale loop present.
    expect(() => parseYaml(out)).not.toThrow();
    expect(out).toContain("for R in lhr fra; do");
    // Best-effort: guarded with `|| echo ::warning::` so a transient scale
    // failure under `set -e` never fails an already-successful deploy.
    expect(out).toContain(
      'flyctl scale count 1 --region "$R" --app "$FLY_APP" --yes || echo "::warning::could not scale $FLY_APP into $R"',
    );
    // Preview blocks stay single-region: the scale loop appears once per
    // non-preview env (staging + production), never inside the preview job.
    const previewJob = out.slice(
      out.indexOf("  preview:"),
      out.indexOf("  teardown:"),
    );
    expect(previewJob).not.toContain("flyctl scale count");
  });
});
