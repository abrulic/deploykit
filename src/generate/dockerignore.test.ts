import { describe, expect, it } from "vitest";
import { generateDockerignore } from "./dockerignore.js";

describe("generateDockerignore", () => {
  const out = generateDockerignore();

  it("ignores dependencies and build artifacts", () => {
    expect(out).toContain("**/node_modules");
    expect(out).toContain("**/.next");
    expect(out).toContain("**/dist");
  });

  it("ignores real env files but keeps the example", () => {
    expect(out).toContain("**/.env");
    expect(out).toContain("!**/.env.example");
  });
});
