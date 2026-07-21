import { describe, expect, it } from "vitest";
import type { DeploykitConfig } from "../config.js";
import {
  sampleApiApp,
  sampleConfig,
  sampleWebApp,
} from "../testing/fixtures.js";
import type { GithubRepo } from "../util/git.js";
import { generateSummary } from "./summary.js";

const repo: GithubRepo = {
  owner: "acme",
  name: "shop",
  url: "https://github.com/acme/shop",
};

describe("generateSummary", () => {
  const md = generateSummary({ config: sampleConfig, repo });

  it("lists every environment of every app with its URL and Fly app", () => {
    expect(md).toContain("## web — `apps/web`");
    expect(md).toContain("| staging | <https://web-staging.fly.dev> |");
    expect(md).toContain("`web-prod`");
    expect(md).toContain("## api — `apps/api`");
    expect(md).toContain("`api-staging`");
  });

  it("renders a preview URL as code, since the {pr} placeholder isn't clickable", () => {
    expect(md).toContain("`https://web-pr-{pr}.fly.dev`");
    expect(md).not.toContain("<https://web-pr-{pr}.fly.dev>");
  });

  it("draws a mermaid flow of the triggers that are configured", () => {
    expect(md).toContain("```mermaid");
    expect(md).toContain('pr["pull request"]');
    expect(md).toContain('main["merge to main"]');
    expect(md).toContain('gate{"manual approval"}');
  });

  it("omits lanes for environments that aren't configured", () => {
    const stagingOnly: DeploykitConfig = {
      ...sampleConfig,
      apps: { api: sampleApiApp },
    };
    const out = generateSummary({ config: stagingOnly, repo });
    expect(out).toContain('main["merge to main"]');
    expect(out).not.toContain('pr["pull request"]');
    expect(out).not.toContain("manual approval");
  });

  it("deep-links the Fly org, tokens page, and each long-lived app", () => {
    expect(md).toContain("https://fly.io/dashboard/acme");
    expect(md).toContain("https://fly.io/dashboard/acme/tokens");
    expect(md).toContain("https://fly.io/apps/web-staging/monitoring");
    expect(md).toContain("https://fly.io/apps/web-prod/secrets");
  });

  it("has no dashboard link for preview apps, which don't exist between PRs", () => {
    expect(md).not.toContain("https://fly.io/apps/web-pr-{pr}");
  });

  it("deep-links GitHub actions, environments and secrets when a remote is known", () => {
    expect(md).toContain(
      "https://github.com/acme/shop/actions/workflows/deploy.yml",
    );
    expect(md).toContain("https://github.com/acme/shop/settings/environments");
    expect(md).toContain(
      "https://github.com/acme/shop/settings/secrets/actions",
    );
  });

  it("omits GitHub links (and says so) when there's no remote", () => {
    const out = generateSummary({ config: sampleConfig, repo: null });
    expect(out).not.toContain("github.com");
    expect(out).toContain("No GitHub remote was found");
  });

  it("lists secret names with their wiring, never values", () => {
    expect(md).toContain("| `DATABASE_URL` | runtime");
    expect(md).toContain("| `NEXT_PUBLIC_API_URL` | build-time");
    expect(md).toContain("| Name | Wired as | Used by |");
  });

  it("drops the secrets section when no app declares any", () => {
    const noSecrets: DeploykitConfig = {
      ...sampleConfig,
      apps: { api: { ...sampleApiApp, secrets: [] } },
    };
    expect(generateSummary({ config: noSecrets, repo })).not.toContain(
      "## Secrets",
    );
  });

  it("links the Cloudflare zone through the account-resolving form", () => {
    const withCf: DeploykitConfig = {
      ...sampleConfig,
      cloudflare: {
        zone: "example.com",
        proxied: true,
        ssl: "strict",
        alwaysUseHttps: true,
        minTlsVersion: "1.2",
        security: true,
        cache: true,
      },
      apps: {
        web: {
          ...sampleWebApp,
          environments: {
            ...sampleWebApp.environments,
            production: {
              name: "web-prod",
              trigger: "manual",
              hostname: "example.com",
            },
          },
        },
      },
    };
    const out = generateSummary({ config: withCf, repo });
    expect(out).toContain(
      "https://dash.cloudflare.com/?to=/:account/example.com/dns",
    );
    // The custom domain replaces the *.fly.dev address in the app table.
    expect(out).toContain("| production | <https://example.com> |");
  });

  it("explains the preview lifecycle and the production gate", () => {
    expect(md).toContain("Preview apps don't exist until a PR opens");
    expect(md).toContain("Production waits for a human");
  });
});
