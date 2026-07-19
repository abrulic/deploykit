import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CREDENTIALS_FILE,
  readCredential,
  saveCredential,
  SECRETS_FILE,
  saveSecretsFile,
} from "./secrets-file.js";
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

describe("credentials file", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });
  const setup = (files: Record<string, string> = {}) => {
    const { root, cleanup } = writeTree({ files });
    cleanups.push(cleanup);
    return root;
  };

  it("saves and reads back a credential", () => {
    const root = setup();
    const res = saveCredential(root, "CLOUDFLARE_API_TOKEN", "tok_abc123");
    expect(res.path).toBe(CREDENTIALS_FILE);
    expect(readCredential(root, "CLOUDFLARE_API_TOKEN")).toBe("tok_abc123");
  });

  it("upserts an existing key without clobbering others", () => {
    const root = setup();
    saveCredential(root, "A", "1");
    saveCredential(root, "B", "2");
    saveCredential(root, "A", "3"); // update A only
    expect(readCredential(root, "A")).toBe("3");
    expect(readCredential(root, "B")).toBe("2");
  });

  it("returns null for a missing file or key", () => {
    const root = setup();
    expect(readCredential(root, "NOPE")).toBeNull();
    saveCredential(root, "A", "1");
    expect(readCredential(root, "NOPE")).toBeNull();
  });

  it("gitignores the credentials file with 0600 perms", () => {
    const root = setup();
    const res = saveCredential(root, "X", "y");
    expect(res.gitignored).toBe(true);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(CREDENTIALS_FILE);
    expect(statSync(join(root, CREDENTIALS_FILE)).mode & 0o777).toBe(0o600);
  });

  it("round-trips a value needing quotes", () => {
    const root = setup();
    saveCredential(root, "X", "has spaces");
    expect(readCredential(root, "X")).toBe("has spaces");
  });

  it("round-trips values with backslashes and escaped quotes", () => {
    const root = setup();
    for (const value of ['a\\"b', "back\\slash", 'ends with \\', '"quoted"']) {
      saveCredential(root, "X", value);
      expect(readCredential(root, "X")).toBe(value);
    }
  });
});
