import { describe, expect, it } from "vitest";
import { writeTree } from "../testing/fixtures.js";
import { parseGithubRemote, readGithubRepo } from "./git.js";

describe("parseGithubRemote", () => {
  it("parses an HTTPS remote", () => {
    expect(parseGithubRemote("https://github.com/acme/shop.git")).toEqual({
      owner: "acme",
      name: "shop",
      url: "https://github.com/acme/shop",
    });
  });

  it("parses an SSH remote", () => {
    expect(parseGithubRemote("git@github.com:acme/shop.git")?.name).toBe(
      "shop",
    );
  });

  it("keeps a name that contains dots", () => {
    expect(parseGithubRemote("git@github.com:acme/shop.dev.git")?.name).toBe(
      "shop.dev",
    );
  });

  it("returns null for a non-GitHub remote", () => {
    expect(parseGithubRemote("git@gitlab.com:acme/shop.git")).toBeNull();
  });
});

describe("readGithubRepo", () => {
  it("finds the GitHub remote in .git/config", () => {
    const { root, cleanup } = writeTree({
      files: {
        ".git/config": `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:acme/shop.git\n`,
      },
    });
    expect(readGithubRepo(root)?.url).toBe("https://github.com/acme/shop");
    cleanup();
  });

  it("returns null when there's no GitHub remote", () => {
    const { root, cleanup } = writeTree({
      files: { ".git/config": '[remote "origin"]\n\turl = /srv/mirror.git\n' },
    });
    expect(readGithubRepo(root)).toBeNull();
    cleanup();
  });

  it("returns null outside a git repo", () => {
    const { root, cleanup } = writeTree({ files: { "package.json": "{}" } });
    expect(readGithubRepo(root)).toBeNull();
    cleanup();
  });
});
