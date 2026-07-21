import { join } from "node:path";
import { readText } from "./fsx.js";

export interface GithubRepo {
  owner: string;
  name: string;
  /** Browser URL of the repo, e.g. "https://github.com/acme/shop". */
  url: string;
}

/**
 * Resolve the GitHub repo from `.git/config`, without shelling out.
 *
 * `gh repo view` is the authoritative lookup (see `getRepo`), but it's async
 * and needs auth — generators are sync and must work offline, so the remote is
 * parsed straight off disk. Returns null for a repo with no GitHub remote (or
 * a worktree/submodule, where `.git` is a file); callers then omit the
 * GitHub-specific links rather than guessing a URL.
 */
export function readGithubRepo(cwd: string): GithubRepo | null {
  const text = readText(join(cwd, ".git", "config"));
  if (text === null) return null;
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*url\s*=\s*(\S+)/);
    if (!m?.[1]) continue;
    const repo = parseGithubRemote(m[1]);
    if (repo) return repo;
  }
  return null;
}

/** Parse an SSH or HTTPS GitHub remote into its owner/name. */
export function parseGithubRemote(remote: string): GithubRepo | null {
  const m = remote.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  const owner = m?.[1];
  const name = m?.[2];
  if (!owner || !name) return null;
  return { owner, name, url: `https://github.com/${owner}/${name}` };
}
