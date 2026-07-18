import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SECRETS_FILE, saveSecretsFile } from "./secrets-file.js";
import { writeTree } from "./testing/fixtures.js";

describe("saveSecretsFile", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  const setup = (files: Record<string, string> = {}) => {
    const { root, cleanup } = writeTree({ files });
    cleanups.push(cleanup);
    return root;
  };

  it("writes grouped entries with a do-not-commit header", () => {
    const root = setup();
    const res = saveSecretsFile({
      cwd: root,
      groups: [
        { label: "Fly", entries: [{ name: "FLY_API_TOKEN", value: "fo1_abc" }] },
        { label: "environment: staging", entries: [{ name: "DATABASE_URL", value: "postgres://x" }] },
      ],
    });
    expect(res.path).toBe(SECRETS_FILE);
    const text = readFileSync(join(root, SECRETS_FILE), "utf8");
    expect(text).toContain("DO NOT COMMIT");
    expect(text).toContain("# Fly");
    expect(text).toContain("FLY_API_TOKEN=fo1_abc");
    expect(text).toContain("# environment: staging");
    expect(text).toContain("DATABASE_URL=postgres://x");
  });

  it("creates the file with owner-only (0600) permissions", () => {
    const root = setup();
    saveSecretsFile({ cwd: root, groups: [{ label: "Fly", entries: [{ name: "T", value: "v" }] }] });
    const mode = statSync(join(root, SECRETS_FILE)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("quotes values that contain whitespace", () => {
    const root = setup();
    saveSecretsFile({
      cwd: root,
      groups: [{ label: "x", entries: [{ name: "A", value: "has spaces" }] }],
    });
    const text = readFileSync(join(root, SECRETS_FILE), "utf8");
    expect(text).toContain('A="has spaces"');
  });

  it("adds the file to .gitignore, creating it if needed", () => {
    const root = setup();
    const res = saveSecretsFile({ cwd: root, groups: [{ label: "x", entries: [{ name: "A", value: "v" }] }] });
    expect(res.gitignored).toBe(true);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(SECRETS_FILE);
  });

  it("doesn't duplicate an existing .gitignore entry", () => {
    const root = setup({ ".gitignore": "node_modules\n.deploykit/\n" });
    saveSecretsFile({ cwd: root, groups: [{ label: "x", entries: [{ name: "A", value: "v" }] }] });
    const text = readFileSync(join(root, ".gitignore"), "utf8");
    // Already ignored via the ".deploykit/" dir entry — no new line added.
    expect(text).toBe("node_modules\n.deploykit/\n");
  });
});
