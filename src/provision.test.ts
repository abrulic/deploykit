import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureGithubEnvironment,
  extractFlyToken,
  listGithubSecretNames,
} from "./provision.js";
import { exec } from "./util/exec.js";

vi.mock("./util/exec.js", () => ({
  exec: vi.fn(),
  tryExec: vi.fn(),
}));
const execMock = vi.mocked(exec);

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
