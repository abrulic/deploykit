import pc from "picocolors";

// OSC 8 hyperlink control bytes, built from their code points so no raw
// control characters live in the source (they corrupt silently in diffs and
// editors). ESC = 0x1b, BEL = 0x07.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

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
  // Strip ESC/BEL from inputs so a stray one can't break out of the sequence
  // or inject terminal escapes, then wrap: ESC ] 8 ;; <url> BEL <label> ESC ] 8 ;; BEL.
  const clean = (s: string) => s.split(ESC).join("").split(BEL).join("");
  const seq = (payload: string) => `${ESC}]8;;${payload}${BEL}`;
  return `${seq(clean(url))}${clean(label)}${seq("")}`;
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
