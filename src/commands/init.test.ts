import { describe, expect, it } from "vitest";
import type { DeploykitConfig } from "../config.js";
import { sampleConfig, sampleWebApp } from "../testing/fixtures.js";
import { renderDestinations } from "./init.js";

// Strip ANSI so assertions read against the visible text.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ANSI escape is the point
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("renderDestinations", () => {
  it("falls back to *.fly.dev when an env has no custom hostname", () => {
    const out = plain(renderDestinations(sampleConfig));
    // web has all three envs; preview keeps the {pr} placeholder.
    expect(out).toContain("https://web-pr-{pr}.fly.dev");
    expect(out).toContain("https://web-staging.fly.dev");
    expect(out).toContain("https://web-prod.fly.dev");
    // api only declares staging — production must not appear for it.
    expect(out).toContain("api-staging");
    expect(out).not.toContain("api-prod");
  });

  it("labels each environment with its deploy trigger", () => {
    const out = plain(renderDestinations(sampleConfig));
    expect(out).toContain("on every pull request");
    expect(out).toContain("on merge to main");
    expect(out).toContain("manual approval");
  });

  it("leads with the custom domain and shows the Cloudflare footer", () => {
    const config: DeploykitConfig = {
      ...sampleConfig,
      cloudflare: {
        zone: "cartiqai.com",
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
            preview: { name: "cartiqai-web-pr-{pr}", trigger: "pr" },
            staging: {
              name: "cartiqai-web-staging",
              trigger: "push:main",
              hostname: "staging.cartiqai.com",
            },
            production: {
              name: "cartiqai-web-production",
              trigger: "manual",
              hostname: "cartiqai.com",
            },
          },
        },
      },
    };
    const out = plain(renderDestinations(config));
    expect(out).toContain("https://staging.cartiqai.com");
    expect(out).toContain("https://cartiqai.com");
    // Fly app name is still surfaced alongside the custom domain.
    expect(out).toContain("fly: cartiqai-web-staging");
    expect(out).toContain(
      "Cloudflare zone cartiqai.com · DNS proxied · SSL strict · HTTPS enforced",
    );
  });

  it("handles an empty app set without throwing", () => {
    const config: DeploykitConfig = { ...sampleConfig, apps: {} };
    expect(plain(renderDestinations(config))).toContain(
      "No environments configured.",
    );
  });
});
