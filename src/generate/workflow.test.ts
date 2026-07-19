import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
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
    const on = (doc as unknown as Record<string, { workflow_dispatch: { inputs: { app: { type: string; options: string[] } } } }>)["on"]!;
    expect(on.workflow_dispatch.inputs.app.type).toBe("choice");
    expect(on.workflow_dispatch.inputs.app.options).toEqual(["all", "web", "api"]);
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
    const jobs = yaml.split(/^  (?=\w+:)/m);
    const jobText = (name: string) => jobs.find((j) => j.startsWith(`${name}:`))!;
    expect(jobText("preview")).toContain("--ha=false");
    expect(jobText("staging")).toContain("--ha=false");
    expect(jobText("production")).not.toContain("--ha=false");
  });

  it("prefixes every Fly app name the workflow creates or targets", () => {
    const prefixed = generateWorkflow({ ...sampleConfig, namePrefix: "acme-shop" });
    expect(prefixed).toContain('FLY_APP="acme-shop-$APP-staging"');
    expect(prefixed).toContain('FLY_APP="acme-shop-$APP-prod"');
    expect(prefixed).toContain('FLY_APP="acme-shop-$APP-pr-${{ github.event.number }}"');
    expect(prefixed).toContain(
      'flyctl apps destroy "acme-shop-${{ matrix.app }}-pr-${{ github.event.number }}"',
    );
    expect(prefixed).toContain(
      'URL="https://acme-shop-$APP-pr-${{ github.event.number }}.fly.dev"',
    );
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
          environments: { staging: { name: "web-staging", trigger: "push:main" } },
        },
      },
    };
    const parsed: ParsedWorkflow = parseYaml(generateWorkflow(stagingOnly));
    expect(Object.keys(parsed.jobs).sort()).toEqual(["changes", "staging"]);
  });
});
