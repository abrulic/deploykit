import { describe, expect, it } from "vitest";
import { sampleConfig } from "../testing/fixtures.js";
import { generateConfigFile } from "./configfile.js";

describe("generateConfigFile", () => {
  const out = generateConfigFile(sampleConfig);

  it("imports and calls defineConfig", () => {
    expect(out).toContain('import { defineConfig } from "deploykit"');
    expect(out).toContain("export default defineConfig(");
  });

  it("round-trips the config as valid embedded JSON", () => {
    const start = out.indexOf("defineConfig(") + "defineConfig(".length;
    const json = out.slice(start, out.lastIndexOf(")"));
    expect(JSON.parse(json)).toMatchObject({
      tool: "turbo",
      provider: { org: "acme" },
    });
  });
});
