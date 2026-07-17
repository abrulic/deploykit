import pc from "picocolors";

/** Thin logging helpers shared outside the clack prompt flow. */
export const log = {
  info: (msg: string) => console.log(msg),
  dim: (msg: string) => console.log(pc.dim(msg)),
  warn: (msg: string) => console.log(`${pc.yellow("!")} ${msg}`),
  error: (msg: string) => console.error(`${pc.red("✖")} ${msg}`),
  success: (msg: string) => console.log(`${pc.green("✔")} ${msg}`),
};

export { pc };
