import * as p from "@clack/prompts";
import { CONFIG_FILE, loadConfigFile } from "../config-file.js";
import { planFiles, writeFiles } from "../generate/index.js";
import type { InitOptions } from "../prompts.js";
import { pc } from "../util/log.js";

/**
 * `deploykit generate` — regenerate every output (Dockerfiles, fly.toml,
 * workflow, .dockerignore) from the committed `deploykit.config.ts`. This is
 * the "config is the source of truth" path: edit the config, re-run generate.
 *
 * Unlike `init`, existing files are overwritten by design — regeneration is
 * the point — but the config file itself is never touched (it's the input).
 */
export async function runGenerate(opts: InitOptions) {
  p.intro(pc.bgCyan(pc.black(" deploykit generate ")));

  const loaded = loadConfigFile(opts.cwd);
  if (loaded.error !== undefined) {
    p.log.error(loaded.error);
    p.outro(pc.red("Generate failed."));
    return 1;
  }

  const files = planFiles({ config: loaded.config, cwd: opts.cwd }).filter(
    (f) => f.path !== CONFIG_FILE,
  );

  p.note(
    files
      .map((f) => {
        const tag =
          f.status === "new"
            ? pc.green(" (new)")
            : f.status === "identical"
              ? pc.dim(" (unchanged)")
              : pc.yellow(" (overwrite)");
        return `  ${f.path}${tag}`;
      })
      .join("\n"),
    `Regenerate from ${CONFIG_FILE}`,
  );

  if (opts.dryRun) {
    p.outro(pc.dim("Dry run complete — no files written."));
    return 0;
  }

  if (!opts.yes) {
    const confirmed = await p.confirm({
      message: "Write these files? (existing ones are overwritten)",
    });
    if (confirmed !== true) {
      p.cancel("Aborted.");
      return 1;
    }
  }

  const { written } = writeFiles({ files, cwd: opts.cwd, force: true });
  for (const f of written) p.log.success(pc.green(`wrote ${f}`));
  p.outro(
    `Regenerated ${written.length} file(s) from ${pc.bold(CONFIG_FILE)}.`,
  );
  return 0;
}
