import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeTree } from "./fixtures.js";

describe("writeTree", () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it("creates nested files with contents", () => {
    const tree = writeTree({
      files: { "a/b/c.txt": "hello", "top.json": "{}" },
    });
    cleanup = tree.cleanup;

    expect(readFileSync(join(tree.root, "a/b/c.txt"), "utf8")).toBe("hello");
    expect(existsSync(join(tree.root, "top.json"))).toBe(true);
  });

  it("handles an empty file map", () => {
    const tree = writeTree({ files: {} });
    cleanup = tree.cleanup;
    expect(existsSync(tree.root)).toBe(true);
  });

  it("cleanup removes the temp dir", () => {
    const tree = writeTree({ files: { "x.txt": "1" } });
    tree.cleanup();
    expect(existsSync(tree.root)).toBe(false);
    cleanup = () => {};
  });
});
