import type { DeploykitConfig, AppConfig } from "../config.js";
import { PM, baseStage, fileHeader, nodeImage, runnerHeader } from "./dockerfile-shared.js";
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
RUN ${pm.install}
# Then the pruned source, and build.
COPY --from=prune /app/out/full/ .
RUN ${pm.run} turbo run build --filter=${filter}
`;

  return head + "\n" + runner({ app, config }) + "\n";
}

function runner({ app, config }: { app: AppConfig; config: DeploykitConfig }) {
  const node = nodeImage(config);
  const pm = PM[config.packageManager];
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

  if (framework === "remix" || framework === "node-server") {
    // Copy the built workspace and run the app's own start script.
    return `${header}

COPY --from=build --chown=appuser:nodejs /app ./
WORKDIR /app/${root}
USER appuser
CMD ${JSON.stringify(pm.start)}
`;
  }

  // static | vite | astro — serve the built output with a tiny static server.
  const spa = framework === "vite" ? " -s" : "";
  return `${header}

RUN npm install -g serve@14
COPY --from=build --chown=appuser:nodejs /app/${root}/dist ./dist
USER appuser
CMD ["serve"${spa ? `, "-s"` : ""}, "-l", "${port}", "dist"]
`;
}
