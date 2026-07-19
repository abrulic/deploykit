import { describe, expect, it } from "vitest";
import { extraRegions, type ProviderConfig } from "./config.js";

const provider = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  type: "fly",
  org: "acme",
  region: "iad",
  ...over,
});

describe("extraRegions", () => {
  it("is empty for a single-region provider (unset regions)", () => {
    expect(extraRegions(provider())).toEqual([]);
  });

  it("is empty when regions only repeats the primary", () => {
    expect(extraRegions(provider({ regions: ["iad"] }))).toEqual([]);
  });

  it("returns regions beyond the primary, primary excluded and deduped", () => {
    expect(
      extraRegions(provider({ regions: ["iad", "lhr", "fra", "lhr"] })),
    ).toEqual(["lhr", "fra"]);
  });

  it("handles the primary appearing anywhere in the list", () => {
    expect(extraRegions(provider({ regions: ["lhr", "iad"] }))).toEqual([
      "lhr",
    ]);
  });
});
