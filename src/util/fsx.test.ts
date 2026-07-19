import { afterEach, describe, expect, it } from "vitest";
import { writeTree } from "../testing/fixtures.js";
import {
  expandWorkspaceGlobs,
  findFilesByName,
  globToRegex,
  listDir,
  readJson,
  readText,
  toPosix,
  walkFilesByExt,
} from "./fsx.js";

describe("toPosix", () => {
  it("converts backslashes to forward slashes", () => {
    expect(toPosix("a\\b\\c")).toBe("a/b/c");
  });
  it("leaves posix paths untouched", () => {
    expect(toPosix("a/b/c")).toBe("a/b/c");
  });
});

describe("globToRegex", () => {
  it("matches a single segment for /*", () => {
    const re = globToRegex("apps/*");
    expect(re.test("apps/web")).toBe(true);
    expect(re.test("apps/web/deep")).toBe(false);
    expect(re.test("packages/ui")).toBe(false);
  });
  it("matches nested segments for /**", () => {
    const re = globToRegex("packages/**");
    expect(re.test("packages/ui")).toBe(true);
    expect(re.test("packages/ui/nested")).toBe(true);
  });
  it("matches a literal path exactly", () => {
    const re = globToRegex("apps/web");
    expect(re.test("apps/web")).toBe(true);
    expect(re.test("apps/webby")).toBe(false);
  });
});

describe("expandWorkspaceGlobs", () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it("finds package dirs matching any glob", () => {
    const tree = writeTree({
      files: {
        "apps/web/package.json": "{}",
        "apps/api/package.json": "{}",
        "packages/ui/package.json": "{}",
      },
    });
    cleanup = tree.cleanup;

    const all = expandWorkspaceGlobs({
      root: tree.root,
      patterns: ["apps/*", "packages/*"],
    }).sort();
    expect(all).toEqual(["apps/api", "apps/web", "packages/ui"]);
  });

  it("honors negation patterns like package managers do", () => {
    const tree = writeTree({
      files: {
        "apps/web/package.json": "{}",
        "apps/legacy/package.json": "{}",
        "packages/ui/package.json": "{}",
      },
    });
    cleanup = tree.cleanup;

    const dirs = expandWorkspaceGlobs({
      root: tree.root,
      patterns: ["apps/*", "packages/*", "!apps/legacy"],
    }).sort();
    expect(dirs).toEqual(["apps/web", "packages/ui"]);
  });

  it("returns empty when nothing matches", () => {
    const tree = writeTree({ files: { "apps/web/package.json": "{}" } });
    cleanup = tree.cleanup;
    expect(
      expandWorkspaceGlobs({ root: tree.root, patterns: ["services/*"] }),
    ).toEqual([]);
  });
});

describe("walkFilesByExt", () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it("collects matching extensions and ignores node_modules", () => {
    const tree = writeTree({
      files: {
        "apps/web/a.ts": "1",
        "apps/web/nested/b.tsx": "2",
        "apps/web/c.css": "3",
        "apps/web/node_modules/d.ts": "4",
      },
    });
    cleanup = tree.cleanup;

    const files = walkFilesByExt({
      root: tree.root,
      subdir: "apps/web",
      exts: ["ts", "tsx"],
      limit: 100,
    }).sort();
    expect(files).toEqual(["apps/web/a.ts", "apps/web/nested/b.tsx"]);
  });

  it("respects the limit", () => {
    const tree = writeTree({
      files: { "s/a.ts": "1", "s/b.ts": "2", "s/c.ts": "3" },
    });
    cleanup = tree.cleanup;
    const files = walkFilesByExt({
      root: tree.root,
      subdir: "s",
      exts: ["ts"],
      limit: 2,
    });
    expect(files.length).toBe(2);
  });
});

describe("findFilesByName", () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it("finds all files with the exact name, skipping node_modules", () => {
    const tree = writeTree({
      files: {
        "apps/web/project.json": "{}",
        "apps/api/project.json": "{}",
        "libs/ui/project.json": "{}",
        "apps/web/other.json": "{}",
        "node_modules/pkg/project.json": "{}",
      },
    });
    cleanup = tree.cleanup;
    const found = findFilesByName({
      root: tree.root,
      filename: "project.json",
      limit: 100,
    }).sort();
    expect(found).toEqual([
      "apps/api/project.json",
      "apps/web/project.json",
      "libs/ui/project.json",
    ]);
  });

  it("returns [] when nothing matches", () => {
    const tree = writeTree({ files: { "a.txt": "1" } });
    cleanup = tree.cleanup;
    expect(
      findFilesByName({
        root: tree.root,
        filename: "project.json",
        limit: 100,
      }),
    ).toEqual([]);
  });
});

describe("readJson / readText / listDir", () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it("reads valid json and text", () => {
    const tree = writeTree({
      files: { "pkg.json": '{"name":"x"}', "note.txt": "hi" },
    });
    cleanup = tree.cleanup;
    expect(readJson<{ name: string }>(`${tree.root}/pkg.json`)?.name).toBe("x");
    expect(readText(`${tree.root}/note.txt`)).toBe("hi");
  });

  it("returns null for missing or invalid input", () => {
    const tree = writeTree({ files: { "bad.json": "{not json" } });
    cleanup = tree.cleanup;
    expect(readJson(`${tree.root}/missing.json`)).toBeNull();
    expect(readJson(`${tree.root}/bad.json`)).toBeNull();
    expect(readText(`${tree.root}/missing.txt`)).toBeNull();
  });

  it("lists a directory and returns [] for a missing one", () => {
    const tree = writeTree({ files: { "dir/a.txt": "1", "dir/b.txt": "2" } });
    cleanup = tree.cleanup;
    expect(listDir(`${tree.root}/dir`).sort()).toEqual(["a.txt", "b.txt"]);
    expect(listDir(`${tree.root}/nope`)).toEqual([]);
  });
});
