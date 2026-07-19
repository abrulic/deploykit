import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkFlyCert,
  ensureGithubEnvironment,
  extractFlyToken,
  listGithubSecretNames,
  parseCertRequirements,
} from "./provision.js";
import { exec } from "./util/exec.js";

vi.mock("./util/exec.js", () => ({
  exec: vi.fn(),
  tryExec: vi.fn(),
}));
const execMock = vi.mocked(exec);

// The exact JSON `flyctl v0.4.71 certs add <host> --json` prints for a
// subdomain (captured live from a scratch app). This is the real shape the
// parser must handle — the pre-fix code looked for DNSValidation* keys that
// don't exist here, so the ACME record was never created.
const REAL_CERT_JSON = JSON.stringify({
  hostname: "probe.deploykit-example.com",
  configured: false,
  status: "Awaiting configuration",
  dns_provider: "gtld-servers",
  certificates: [],
  dns_requirements: {
    a: [],
    aaaa: [],
    cname: "6n0ge80.deploykit-probe-12643.fly.dev",
    acme_challenge: {
      name: "_acme-challenge.probe.deploykit-example.com",
      target: "probe.deploykit-example.com.6n0ge80.flydns.net.",
    },
    ownership: {
      name: "_fly-ownership.probe.deploykit-example.com",
      app_value: "app-6n0ge80",
      org_value: "org-6ko19o",
    },
  },
});

describe("parseCertRequirements", () => {
  it("extracts the CNAME, ACME challenge, and ownership TXT from real flyctl JSON", () => {
    const r = parseCertRequirements(REAL_CERT_JSON);
    expect(r.configured).toBe(false);
    expect(r.status).toBe("Awaiting configuration");
    expect(r.records).toEqual([
      {
        type: "CNAME",
        name: "probe.deploykit-example.com",
        content: "6n0ge80.deploykit-probe-12643.fly.dev",
      },
    ]);
    // Trailing dot stripped — Cloudflare records don't want it.
    expect(r.acmeChallenge).toEqual({
      name: "_acme-challenge.probe.deploykit-example.com",
      target: "probe.deploykit-example.com.6n0ge80.flydns.net",
    });
    expect(r.ownership).toEqual({
      name: "_fly-ownership.probe.deploykit-example.com",
      value: "app-6n0ge80",
    });
  });

  it("uses A/AAAA records for an apex domain (no cname)", () => {
    const apex = JSON.stringify({
      hostname: "example.com",
      configured: true,
      status: "Ready",
      dns_requirements: {
        cname: "",
        a: ["66.241.125.100"],
        aaaa: ["2a09:8280:1::1:2"],
      },
    });
    const r = parseCertRequirements(apex);
    expect(r.configured).toBe(true);
    expect(r.records).toEqual([
      { type: "A", name: "example.com", content: "66.241.125.100" },
      { type: "AAAA", name: "example.com", content: "2a09:8280:1::1:2" },
    ]);
  });

  it("returns no records (not a crash) when Fly gives no routable target", () => {
    const none = JSON.stringify({
      hostname: "x.example.com",
      dns_requirements: { cname: "", a: [], aaaa: [] },
    });
    const r = parseCertRequirements(none);
    expect(r.records).toEqual([]);
    expect(r.acmeChallenge).toBeUndefined();
    expect(r.ownership).toBeUndefined();
  });

  it("degrades to empty on non-JSON without throwing", () => {
    expect(parseCertRequirements("not json")).toEqual({});
  });
});

describe("checkFlyCert", () => {
  beforeEach(() => execMock.mockReset());

  it("reports configured=true once Fly marks the cert Ready", async () => {
    execMock.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ configured: true, status: "Ready" }),
      stderr: "",
    });
    expect(await checkFlyCert({ hostname: "h", app: "a", cwd: "." })).toEqual({
      configured: true,
      status: "Ready",
    });
  });

  it("returns null when the status can't be read (transient flyctl failure)", async () => {
    execMock.mockResolvedValue({ code: 1, stdout: "", stderr: "boom" });
    expect(
      await checkFlyCert({ hostname: "h", app: "a", cwd: "." }),
    ).toBeNull();
  });
});

describe("extractFlyToken", () => {
  it("extracts a FlyV1 macaroon from plain output", () => {
    const out = "FlyV1 fm2_lJPECAAAA_base64ish-token_,fm2_more";
    expect(extractFlyToken(out)).toBe(out);
  });

  it("finds the token amid surrounding text", () => {
    const raw = [
      "Creating org deploy token...",
      "FlyV1 fm2_abc123",
      "Keep this token safe.",
    ].join("\n");
    expect(extractFlyToken(raw)).toBe("FlyV1 fm2_abc123");
  });

  it("pulls the token out of JSON output", () => {
    expect(extractFlyToken('{"token":"FlyV1 fm2_xyz"}')).toBe("FlyV1 fm2_xyz");
  });

  it("returns null when there's no token", () => {
    expect(extractFlyToken("Error: not authenticated")).toBeNull();
    expect(extractFlyToken("")).toBeNull();
  });
});

describe("listGithubSecretNames", () => {
  beforeEach(() => execMock.mockReset());

  it("parses the secret names on success", async () => {
    execMock.mockResolvedValue({
      code: 0,
      stdout: "FLY_API_TOKEN\nDATABASE_URL\n",
      stderr: "",
    });
    const names = await listGithubSecretNames({ cwd: "/repo" });
    expect(names).toEqual(new Set(["FLY_API_TOKEN", "DATABASE_URL"]));
  });

  it("returns an empty set when there are genuinely no secrets", async () => {
    execMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    expect(await listGithubSecretNames({ cwd: "/repo" })).toEqual(new Set());
  });

  it("returns null (not an empty set) when gh fails", async () => {
    // An auth hiccup must be distinguishable from "no secrets" — the token
    // step would otherwise mint a duplicate org token on every run.
    execMock.mockResolvedValue({ code: 1, stdout: "", stderr: "auth error" });
    expect(await listGithubSecretNames({ cwd: "/repo" })).toBeNull();
  });
});

describe("ensureGithubEnvironment", () => {
  beforeEach(() => execMock.mockReset());

  it("URL-encodes the environment name in the API path", async () => {
    execMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    await ensureGithubEnvironment({
      env: "my env/eu",
      repo: "acme/shop",
      cwd: "/repo",
    });
    const args = execMock.mock.calls[0]![0].args;
    expect(args).toContain("/repos/acme/shop/environments/my%20env%2Feu");
  });
});
