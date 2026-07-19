import pc from "picocolors";

/**
 * Render `label` as a clickable terminal hyperlink (OSC 8) pointing at `url`,
 * so long/ugly URLs collapse to a readable link. Falls back to plain
 * `label (url)` where hyperlinks aren't supported (non-TTY, dumb terminals,
 * or NO_COLOR) so the URL stays reachable in logs and pipes.
 */
export function link(label: string, url: string): string {
  const supported =
    !!process.stdout.isTTY &&
    !process.env.NO_COLOR &&
    process.env.TERM !== "dumb";
  if (!supported) return `${label} (${url})`;
  // OSC 8 hyperlink: ESC ] 8 ;; <url> BEL <label> ESC ] 8 ;; BEL
  const seq = (payload: string) => `]8;;${payload}`;
  return `${seq(url)}${label}${seq("")}`;
}

/** Thin logging helpers shared outside the clack prompt flow. */
export const log = {
  info: (msg: string) => console.log(msg),
  dim: (msg: string) => console.log(pc.dim(msg)),
  warn: (msg: string) => console.log(`${pc.yellow("!")} ${msg}`),
  error: (msg: string) => console.error(`${pc.red("✖")} ${msg}`),
  success: (msg: string) => console.log(`${pc.green("✔")} ${msg}`),
};

export { pc };
