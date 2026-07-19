import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeploykitConfig } from "./config.js";
import { ensureFlyCert } from "./provision.js";
import {
  awaitCertIssuance,
  domainTargets,
  provisionCloudflare,
} from "./provision-cloudflare.js";

// Keep the real module but stub the flyctl-shelling cert call, so the
// Cloudflare wiring can be exercised without a Fly account.
vi.mock("./provision.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provision.js")>();
  return { ...actual, ensureFlyCert: vi.fn() };
});
const ensureFlyCertMock = vi.mocked(ensureFlyCert);

const baseApp = {
  root: "apps/web",
  packageName: "@acme/web",
  framework: "vite" as const,
  port: 4173,
  internalDeps: [],
  watchPaths: ["apps/web/**"],
  secrets: [],
};

function configWith(
  envs: DeploykitConfig["apps"]["web"]["environments"],
): DeploykitConfig {
  return {
    tool: "nx",
    packageManager: "pnpm",
    nodeVersion: "20",
    provider: { type: "fly", org: "acme", region: "iad" },
    apps: { web: { ...baseApp, environments: envs } },
    cloudflare: {
      zone: "example.com",
      proxied: true,
      ssl: "strict",
      alwaysUseHttps: true,
      minTlsVersion: "1.2",
      security: true,
      cache: true,
    },
  };
}

describe("domainTargets", () => {
  it("collects staging/production hostnames and ignores previews + missing ones", () => {
    const config = configWith({
      preview: {
        name: "web-pr-{pr}",
        trigger: "pr",
        hostname: "ignored.example.com",
      },
      staging: {
        name: "web-staging",
        trigger: "push:main",
        hostname: "staging.example.com",
      },
      production: { name: "web-prod", trigger: "manual" }, // no hostname → skipped
    });
    expect(domainTargets(config)).toEqual([
      { hostname: "staging.example.com", flyApp: "web-staging" },
    ]);
  });
});

describe("provisionCloudflare", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns nothing when there's no cloudflare config", async () => {
    const config = configWith({
      staging: { name: "web-staging", trigger: "push:main" },
    });
    delete config.cloudflare;
    expect(await provisionCloudflare({ config, token: "t", cwd: "." })).toEqual(
      [],
    );
  });

  it("stops with a failed step when the zone can't be verified", async () => {
    // getZone returns an empty list → zone not found / not owned.
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, errors: [], result: [] }),
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const config = configWith({
      staging: {
        name: "web-staging",
        trigger: "push:main",
        hostname: "staging.example.com",
      },
    });
    const results = await provisionCloudflare({ config, token: "t", cwd: "." });
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.label).toContain("example.com");
    // Only the zone lookup happened — no cert/DNS calls after the short-circuit.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("wires the ownership TXT, Fly's CNAME target, and the ACME challenge", async () => {
    ensureFlyCertMock.mockResolvedValue({
      ok: true,
      configured: false,
      records: [
        {
          type: "CNAME",
          name: "staging.example.com",
          content: "6n0.web-staging.fly.dev",
        },
      ],
      acmeChallenge: {
        name: "_acme-challenge.staging.example.com",
        target: "staging.example.com.6n0.flydns.net",
      },
      ownership: {
        name: "_fly-ownership.staging.example.com",
        value: "app-6n0",
      },
    });
    const { posts } = stubCloudflare();

    const config = configWith({
      staging: {
        name: "web-staging",
        trigger: "push:main",
        hostname: "staging.example.com",
      },
    });
    await provisionCloudflare({ config, token: "t", cwd: "." });

    // Ownership TXT — DNS-only, so Fly can verify control behind the proxy.
    expect(posts()).toContainEqual(
      expect.objectContaining({
        type: "TXT",
        name: "_fly-ownership.staging.example.com",
        content: "app-6n0",
        proxied: false,
      }),
    );
    // Main record points at Fly's real CNAME target (not "<app>.fly.dev"), proxied.
    expect(posts()).toContainEqual(
      expect.objectContaining({
        type: "CNAME",
        name: "staging.example.com",
        content: "6n0.web-staging.fly.dev",
        proxied: true,
      }),
    );
    // ACME challenge — DNS-only, or Fly can't complete DNS-01 validation.
    expect(posts()).toContainEqual(
      expect.objectContaining({
        type: "CNAME",
        name: "_acme-challenge.staging.example.com",
        content: "staging.example.com.6n0.flydns.net",
        proxied: false,
      }),
    );
  });

  it("reports a failure (not silence) when Fly returns no routable target", async () => {
    ensureFlyCertMock.mockResolvedValue({ ok: true, records: [] });
    stubCloudflare();
    const config = configWith({
      staging: {
        name: "web-staging",
        trigger: "push:main",
        hostname: "staging.example.com",
      },
    });
    const results = await provisionCloudflare({ config, token: "t", cwd: "." });
    expect(results).toContainEqual(
      expect.objectContaining({
        ok: false,
        detail: expect.stringContaining("no DNS target"),
      }),
    );
  });
});

describe("awaitCertIssuance", () => {
  const oneStaging = () =>
    configWith({
      staging: {
        name: "web-staging",
        trigger: "push:main",
        hostname: "staging.example.com",
      },
    });

  it("returns 'issued' as soon as the cert reports configured, without sleeping", async () => {
    const check = vi.fn(async () => ({ configured: true }));
    const sleep = vi.fn(async () => {});
    const res = await awaitCertIssuance({
      config: oneStaging(),
      cwd: ".",
      deps: { check, sleep },
    });
    expect(res).toEqual([
      { label: "Certificate staging.example.com issued", ok: true },
    ]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("reports still-pending (ok, with detail) when the budget runs out", async () => {
    const check = vi.fn(async () => ({ configured: false }));
    const sleep = vi.fn(async () => {});
    const res = await awaitCertIssuance({
      config: oneStaging(),
      cwd: ".",
      attempts: 3,
      intervalMs: 1,
      deps: { check, sleep },
    });
    expect(res[0]!.ok).toBe(true);
    expect(res[0]!.detail).toContain("still pending");
    expect(check).toHaveBeenCalledTimes(3);
    // Sleeps between attempts only — not after the final one.
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});

/**
 * Stub `fetch` for the Cloudflare REST client: the zone lookup resolves the
 * zone, DNS-record lookups come back empty (so upserts POST), rulesets read as
 * empty, and everything succeeds. `posts()` returns the bodies of DNS-record
 * POSTs for assertions.
 */
function stubCloudflare() {
  const calls: {
    method: string;
    url: string;
    body?: Record<string, unknown>;
  }[] = [];
  const spy = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = (init.method as string) ?? "GET";
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url, body });
    let result: unknown = {};
    if (method === "GET" && url.includes("/zones?name=")) {
      result = [{ id: "zone1", name: "example.com" }];
    } else if (method === "GET" && url.includes("/dns_records")) {
      result = []; // no existing record → upsert POSTs a new one
    } else if (method === "GET" && url.includes("/rulesets/")) {
      result = { rules: [] };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, errors: [], result }),
    };
  });
  vi.stubGlobal("fetch", spy);
  const posts = () =>
    calls
      .filter((c) => c.method === "POST" && c.url.includes("/dns_records"))
      .map((c) => c.body);
  return { calls, posts };
}
