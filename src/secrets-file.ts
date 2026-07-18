import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Workspace-relative path of the local secrets copy. */
export const SECRETS_FILE = ".deploykit/secrets.local.env";

export interface SecretGroup {
  /** Section label, e.g. "Fly" or "environment: staging". */
  label: string;
  entries: { name: string; value: string }[];
}

export interface SaveSecretsResult {
  /** Workspace-relative path written. */
  path: string;
  /** Whether the path is covered by .gitignore after this call. */
  gitignored: boolean;
}

/**
 * Write captured secret values to a gitignored, owner-only (0600) file so the
 * user can move them into a password manager. Overwrites on each run — GitHub
 * and Fly already hold the authoritative copies; this is a throwaway export.
 */
export function saveSecretsFile({
  cwd,
  groups,
}: {
  cwd: string;
  groups: SecretGroup[];
}): SaveSecretsResult {
  const abs = join(cwd, SECRETS_FILE);
  mkdirSync(dirname(abs), { recursive: true });

  const lines = [
    "# deploykit — LOCAL secret copies. DO NOT COMMIT.",
    "# Plaintext, for your reference only. Move these into 1Password / your",
    "# secret manager, then delete this file — GitHub and Fly already have them.",
    `# Written ${new Date().toISOString().slice(0, 10)}.`,
    "",
  ];
  for (const g of groups) {
    if (g.entries.length === 0) continue;
    lines.push(`# ${g.label}`);
    for (const { name, value } of g.entries) lines.push(`${name}=${quote(value)}`);
    lines.push("");
  }

  // mode on writeFileSync only applies when creating; chmod covers the
  // overwrite case (and is a best-effort no-op on non-POSIX filesystems).
  writeFileSync(abs, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(abs, 0o600);
  } catch {
    /* non-POSIX — perms are advisory */
  }

  return { path: SECRETS_FILE, gitignored: ensureGitignored(cwd, SECRETS_FILE) };
}

/**
 * Reusable local credentials (e.g. CLOUDFLARE_API_TOKEN), kept separate from
 * the throwaway secrets dump so a `saveSecretsFile` rewrite can't clobber them.
 */
export const CREDENTIALS_FILE = ".deploykit/credentials";

/** Read a saved credential value from the local credentials file, or null. */
export function readCredential(cwd: string, name: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(cwd, CREDENTIALS_FILE), "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && m[1] === name) return unquote((m[2] ?? "").trim());
  }
  return null;
}

/** Upsert a credential into the gitignored, 0600 credentials file (other lines preserved). */
export function saveCredential(cwd: string, name: string, value: string): SaveSecretsResult {
  const abs = join(cwd, CREDENTIALS_FILE);
  mkdirSync(dirname(abs), { recursive: true });

  let existing = "";
  try {
    existing = readFileSync(abs, "utf8");
  } catch {
    /* new file */
  }

  const line = `${name}=${quote(value)}`;
  const re = new RegExp(`^\\s*${name}\\s*=`);
  const lines = existing ? existing.split("\n") : [];
  let replaced = false;
  const out = lines.map((l) => (re.test(l) ? ((replaced = true), line) : l));
  if (!replaced) {
    if (out.length === 0) out.push("# deploykit — LOCAL credentials, gitignored. Reused across runs.");
    out.push(line);
  }

  writeFileSync(abs, `${out.join("\n").replace(/\n*$/, "")}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(abs, 0o600);
  } catch {
    /* non-POSIX — perms are advisory */
  }

  return { path: CREDENTIALS_FILE, gitignored: ensureGitignored(cwd, CREDENTIALS_FILE) };
}

/** Add `entry` to .gitignore if it isn't already ignored. Returns success. */
function ensureGitignored(cwd: string, entry: string): boolean {
  const path = join(cwd, ".gitignore");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    /* no .gitignore yet — we'll create it */
  }
  const dir = `${entry.split("/")[0]}/`; // e.g. ".deploykit/"
  const already = text
    .split("\n")
    .map((l) => l.trim())
    .some((l) => l === entry || l === dir);
  if (already) return true;

  const prefix = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
  try {
    appendFileSync(
      path,
      `${prefix}\n# deploykit local secrets — never commit\n${entry}\n`,
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

/** Quote dotenv values that contain whitespace or comment/quote characters. */
function quote(value: string) {
  return /[\s#"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** Reverse of `quote` — strip surrounding double quotes and unescape. */
function unquote(value: string) {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1).replace(/\\"/g, '"')
    : value;
}
