import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sampleConfig, writeTree } from "../testing/fixtures.js";
import { planFiles, writeFiles } from "./index.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** A fresh empty repo dir. */
function emptyRepo() {
  const { root, cleanup } = writeTree({ files: {} });
  cleanups.push(cleanup);
  return root;
}

function write(root: string, rel: string, contents: string) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents, "utf8");
}

const statusOf = (root: string, path: string) =>
  planFiles({ config: sampleConfig, cwd: root }).find((f) => f.path === path)
    ?.status;

describe("planFiles classification", () => {
  it("marks every file new in an empty repo", () => {
    const files = planFiles({ config: sampleConfig, cwd: emptyRepo() });
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.status === "new")).toBe(true);
  });

  it("plans a DEPLOYMENTS.md alongside the generated files", () => {
    const root = emptyRepo();
    const summary = planFiles({ config: sampleConfig, cwd: root }).find(
      (f) => f.path === "DEPLOYMENTS.md",
    );
    // Written from the repo's own remote, so an empty temp dir gets no GitHub
    // links — the file is still generated.
    expect(summary?.contents).toContain("## web");
  });

  it("marks a byte-for-byte match identical", () => {
    const root = emptyRepo();
    const planned = planFiles({ config: sampleConfig, cwd: root });
    const target = planned.find((f) => f.path === ".dockerignore");
    if (!target) throw new Error("no .dockerignore in plan");
    write(root, target.path, target.contents);
    expect(statusOf(root, ".dockerignore")).toBe("identical");
  });

  it("ignores trailing-whitespace / CRLF differences", () => {
    const root = emptyRepo();
    const target = planFiles({ config: sampleConfig, cwd: root }).find(
      (f) => f.path === ".dockerignore",
    );
    if (!target) throw new Error("no .dockerignore in plan");
    write(root, target.path, `${target.contents.replace(/\n/g, "\r\n")}\n\n  `);
    expect(statusOf(root, ".dockerignore")).toBe("identical");
  });

  it("marks a hand-edited file modified", () => {
    const root = emptyRepo();
    const target = planFiles({ config: sampleConfig, cwd: root }).find(
      (f) => f.path === ".dockerignore",
    );
    if (!target) throw new Error("no .dockerignore in plan");
    write(root, target.path, `${target.contents}\n# my hand edit\n`);
    expect(statusOf(root, ".dockerignore")).toBe("modified");
  });
});

describe("writeFiles honors classification", () => {
  it("never clobbers a modified file without force, but writes new ones", () => {
    const root = emptyRepo();
    write(root, ".dockerignore", "# my hand edit\n");

    const { written, skipped } = writeFiles({
      files: planFiles({ config: sampleConfig, cwd: root }),
      cwd: root,
      force: false,
    });

    expect(skipped).toContain(".dockerignore");
    expect(readFileSync(join(root, ".dockerignore"), "utf8")).toBe(
      "# my hand edit\n",
    );
    // A file that didn't exist was written.
    expect(written).toContain("deploykit.config.ts");
  });

  it("overwrites a modified file with force", () => {
    const root = emptyRepo();
    write(root, ".dockerignore", "# my hand edit\n");

    writeFiles({
      files: planFiles({ config: sampleConfig, cwd: root }),
      cwd: root,
      force: true,
    });

    expect(readFileSync(join(root, ".dockerignore"), "utf8")).not.toContain(
      "my hand edit",
    );
  });
});
