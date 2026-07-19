import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GeneratedFile } from "./generate/index.js";
import { openPr, type PrDeps } from "./pr.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** A working repo (on `main`, one commit) wired to a bare `origin` so push works. */
function setupRepo() {
  const remote = mkdtempSync(join(tmpdir(), "deploykit-remote-"));
  execFileSync("git", ["init", "--bare", "-b", "main", remote], {
    stdio: "pipe",
  });
  const root = mkdtempSync(join(tmpdir(), "deploykit-repo-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "t@t.co");
  git(root, "config", "user.name", "t");
  writeFileSync(join(root, "README.md"), "readme\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "init");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-u", "origin", "main");
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  });
  return { root, remote };
}

/** Build the GeneratedFile[] and (as `init` does) pre-write them into the work tree. */
function stageGenerated(root: string, contents: string): GeneratedFile[] {
  const files: GeneratedFile[] = [
    { path: "apps/web/Dockerfile", contents, status: "new" },
    {
      path: "deploykit.config.ts",
      contents: "export default {}\n",
      status: "new",
    },
  ];
  for (const f of files) {
    const abs = join(root, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.contents, "utf8");
  }
  return files;
}

/** Fake `gh`: records createPr calls and remembers the "open" PR URL. */
function fakeGh(): {
  deps: PrDeps;
  state: { url: string | null; created: number };
} {
  const state = { url: null as string | null, created: 0 };
  return {
    state,
    deps: {
      findOpenPr: async () => state.url,
      createPr: async () => {
        state.created += 1;
        state.url = "https://github.com/acme/repo/pull/1";
        return { url: state.url };
      },
    },
  };
}

const commitCount = (root: string, branch: string) =>
  Number(git(root, "rev-list", "--count", branch));

describe("openPr", () => {
  it("first run: commits on the setup branch, opens a PR, returns to the original branch", async () => {
    const { root } = setupRepo();
    const { deps, state } = fakeGh();
    const files = stageGenerated(root, "FROM node\n");

    const res = await openPr({ cwd: root, files, deps });

    expect(res.ok).toBe(true);
    expect(res.url).toBe("https://github.com/acme/repo/pull/1");
    expect(res.restoredTo).toBe("main");
    expect(state.created).toBe(1);
    expect(git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    // The generated files were committed on the branch, not left on main.
    expect(git(root, "show", "deploykit/ci-setup:apps/web/Dockerfile")).toBe(
      "FROM node",
    );
  });

  it("is re-runnable: an identical second run reuses the PR and adds no commit", async () => {
    const { root } = setupRepo();
    const { deps, state } = fakeGh();

    await openPr({
      cwd: root,
      files: stageGenerated(root, "FROM node\n"),
      deps,
    });
    const before = commitCount(root, "deploykit/ci-setup");

    // Second run: init re-writes the same files into the work tree, then openPr.
    const res = await openPr({
      cwd: root,
      files: stageGenerated(root, "FROM node\n"),
      deps,
    });

    expect(res.ok).toBe(true);
    expect(res.url).toBe("https://github.com/acme/repo/pull/1");
    expect(state.created).toBe(1); // reused, not re-created
    expect(commitCount(root, "deploykit/ci-setup")).toBe(before); // no empty commit
  });

  it("a re-run with changed content updates the branch and reuses the PR", async () => {
    const { root } = setupRepo();
    const { deps, state } = fakeGh();

    await openPr({
      cwd: root,
      files: stageGenerated(root, "FROM node\n"),
      deps,
    });
    const before = commitCount(root, "deploykit/ci-setup");

    const res = await openPr({
      cwd: root,
      files: stageGenerated(root, "FROM node:20\nRUN echo new\n"),
      deps,
    });

    expect(res.ok).toBe(true);
    expect(state.created).toBe(1);
    expect(commitCount(root, "deploykit/ci-setup")).toBe(before + 1);
    expect(git(root, "show", "deploykit/ci-setup:apps/web/Dockerfile")).toBe(
      "FROM node:20\nRUN echo new",
    );
  });

  it("preserves the user's other uncommitted work across a re-run", async () => {
    const { root } = setupRepo();
    const { deps } = fakeGh();

    await openPr({
      cwd: root,
      files: stageGenerated(root, "FROM node\n"),
      deps,
    });

    // Back on main, the user has unrelated uncommitted work.
    writeFileSync(join(root, "README.md"), "readme\nmy important edit\n");
    writeFileSync(join(root, "NOTES.txt"), "scratch\n");

    await openPr({
      cwd: root,
      files: stageGenerated(root, "FROM node\n"),
      deps,
    });

    expect(git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain(
      "my important edit",
    );
    expect(existsSync(join(root, "NOTES.txt"))).toBe(true);
  });

  it("returns to the original branch when the PR step fails", async () => {
    const { root } = setupRepo();
    const { deps } = fakeGh();
    const failing: Partial<PrDeps> = {
      createPr: async () => ({
        url: null,
        detail: "gh pr create failed: boom",
      }),
    };

    const res = await openPr({
      cwd: root,
      files: stageGenerated(root, "FROM node\n"),
      deps: { ...deps, ...failing },
    });

    expect(res.ok).toBe(false);
    expect(res.detail).toContain("boom");
    expect(res.restoredTo).toBe("main");
    expect(git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("does nothing when there are no files", async () => {
    const { root } = setupRepo();
    const res = await openPr({ cwd: root, files: [], deps: fakeGh().deps });
    expect(res.ok).toBe(false);
    expect(res.detail).toBe("nothing to commit");
  });
});
