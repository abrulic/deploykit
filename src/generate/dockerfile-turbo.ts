import type { AppConfig, DeploykitConfig } from "../config.js";
import {
  baseStage,
  buildEnvLines,
  fileHeader,
  installLine,
  nodeImage,
  PM,
  prismaSteps,
  runnerHeader,
  serveModel,
  serverCmd,
} from "./dockerfile-shared.js";
import type { GenerateAppFileInput } from "./types.js";

/**
 * Turbo Dockerfile: `turbo prune --docker` isolates this app plus its internal
 * workspace deps into a minimal context, so the install layer caches properly.
 */
export function turboDockerfile({ name, app, config }: GenerateAppFileInput) {
  const pm = PM[config.packageManager];
  const filter = app.packageName;

  const head = `${fileHeader({ root: app.root, base: baseStage(config) })}

# ── prune: isolate ${name} + its workspace deps ──────────────────────────────
FROM base AS prune
WORKDIR /app
COPY . .
RUN ${pm.dlx} turbo prune ${filter} --docker

# ── install + build ──────────────────────────────────────────────────────────
FROM base AS build
WORKDIR /app
# Lockfile + package manifests first for a cacheable install layer.
COPY --from=prune /app/out/json/ .
RUN ${installLine(pm, config)}
# Then the pruned source, and build.
COPY --from=prune /app/out/full/ .
${buildEnvLines(app)}${prismaSteps(app, pm)}RUN ${pm.run} turbo run build --filter=${filter}
`;

  return `${head}\n${runner({ app, config })}\n`;
}

function runner({ app, config }: { app: AppConfig; config: DeploykitConfig }) {
  const node = nodeImage(config);
  const { root, port, framework } = app;
  const header = runnerHeader({ node, port });

  if (framework === "next") {
    return `${header}

# Requires \`output: "standalone"\` in ${root}/next.config.{js,mjs,ts}.
COPY --from=build --chown=appuser:nodejs /app/${root}/.next/standalone ./
COPY --from=build --chown=appuser:nodejs /app/${root}/.next/static ./${root}/.next/static
COPY --from=build --chown=appuser:nodejs /app/${root}/public ./${root}/public
USER appuser
CMD ["node", "${root}/server.js"]
`;
  }

  if (serveModel(app) === "server") {
    // Copy the built workspace and run the app's own start command (or `npm
    // start` when no explicit command was detected — see serverCmd).
    const cmd = serverCmd(app);
    return `${header}

COPY --from=build --chown=appuser:nodejs /app ./
WORKDIR /app/${root}
USER appuser
CMD ${cmd}
`;
  }

  // static | vite | astro — serve the built output with a tiny static server.
  const dir = app.outputDir ?? `${root}/dist`;
  const spa = app.spa ?? framework === "vite";
  return `${header}

RUN npm install -g serve@14
COPY --from=build --chown=appuser:nodejs /app/${dir} ./dist
USER appuser
CMD ["serve"${spa ? `, "-s"` : ""}, "-l", "${port}", "dist"]
`;
}
