import { describe, expect, it } from "vitest";
import { extractFlyToken } from "./provision.js";

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
