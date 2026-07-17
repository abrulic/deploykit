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

  it("stages each app's secrets, guarded against unset values", () => {
    expect(yaml).toContain('if [ -n "${{ secrets.DATABASE_URL }}" ]');
  });

  it("uses a bare matrix.app in the production if-guard (no nested expansion)", () => {
    expect(yaml).toContain("github.event.inputs.app == matrix.app");
    expect(yaml).not.toContain("github.event.inputs.app == ${{ matrix.app }}");
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
