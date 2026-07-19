import { spawn } from "node:child_process";

export interface ExecInput {
  cmd: string;
  args: string[];
  cwd?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command, capturing output. Never rejects on non-zero exit. */
export const exec = ({ cmd, args, cwd }: ExecInput) =>
  new Promise<ExecResult>((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) =>
      resolve({ code: 127, stdout, stderr: stderr + String(err) }),
    );
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });

/** Run a command and return trimmed stdout, or null if it failed. */
export const tryExec = async (input: ExecInput) => {
  const res = await exec(input);
  return res.code === 0 ? res.stdout.trim() : null;
};

/**
 * Run a command with the terminal handed straight to it (`stdio: "inherit"`),
 * for interactive CLIs like `gh auth login` / `flyctl auth login` that render
 * their own prompts and open a browser. Output isn't captured — the child owns
 * stdin/stdout/stderr. Resolves with the exit code (127 if it can't spawn).
 */
export const execInteractive = ({ cmd, args, cwd }: ExecInput) =>
  new Promise<number>((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: false, stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 0));
  });

/** True if a command exists on PATH (`which` on POSIX, `where` on Windows). */
export const commandExists = async (command: string) => {
  const finder = process.platform === "win32" ? "where" : "which";
  const res = await exec({ cmd: finder, args: [command] });
  return res.code === 0;
};
