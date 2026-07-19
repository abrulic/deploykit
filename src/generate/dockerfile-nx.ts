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
 * Nx Dockerfile. Nx has no `turbo prune`, so we build the whole workspace and
 * either copy the app's build output (static / integrated bundle) or ship the
 * built workspace and run the app's start command (SSR / server).
 */
export function nxDockerfile({ app, config }: GenerateAppFileInput) {
  const pm = PM[config.packageManager];
  const project = app.packageName; // the Nx project name (`nx build <project>`)
  // Package-based Nx targets are plain package.json scripts with no
  // `production` configuration — only integrated (project.json) repos have one.
  const integrated = config.nxIntegrated ?? true;
  const productionFlag = integrated ? " --configuration=production" : "";

  const head = `${fileHeader({ root: app.root, base: baseStage(config) })}

# ── install + build (Nx) ─────────────────────────────────────────────────────
FROM base AS build
WORKDIR /app
COPY . .
RUN ${installLine(pm, config)}
${buildEnvLines(app)}${prismaSteps(app, pm)}RUN ${pm.run} nx build ${project}${productionFlag}
`;

  return `${head}\n${runner({ app, config })}\n`;
}

function runner({ app, config }: { app: AppConfig; config: DeploykitConfig }) {
  const node = nodeImage(config);
  const { root, port, framework } = app;
  const integrated = config.nxIntegrated ?? true;
  const out = `dist/${root}`; // Nx default output location (integrated)
  const header = runnerHeader({ node, port });

  if (framework === "next") {
    return `${header}

# Nx builds Next to ${out}. Requires \`output: "standalone"\` in the app's next.config;
# verify these paths match your Nx Next output before the first deploy.
COPY --from=build --chown=appuser:nodejs /app/${out}/.next/standalone ./
COPY --from=build --chown=appuser:nodejs /app/${out}/.next/static ./.next/static
COPY --from=build --chown=appuser:nodejs /app/${out}/public ./public
USER appuser
CMD ["node", "server.js"]
`;
  }

  if (serveModel(app) === "server") {
    // Integrated Nx bundles the server + a pruned package.json to dist/<root>,
    // so ship just that and run it — the lean path for @nx/esbuild|webpack apps.
    // The install must use npm: the runner is a bare node image (no corepack
    // enable), so pnpm/yarn/bun aren't on PATH — and the pruned package.json
    // has no lockfile or workspace: refs, so npm handles it for every manager.
    if (
      integrated &&
      !app.startCommand &&
      (framework === "remix" || framework === "node-server")
    ) {
      return `${header}

COPY --from=build --chown=appuser:nodejs /app/${out} ./
RUN npm install --omit=dev
USER appuser
CMD ["node", "main.js"]
`;
    }
    // General server (SSR frameworks, package-based Nx, or an explicit command):
    // ship the built workspace and run the app's own start command. Copying the
    // whole workspace is robust to whatever layout the framework emits.
    const cmd = serverCmd(app);
    return `${header}

# SSR / server runtime — copy the built workspace and run the app's start command.
COPY --from=build --chown=appuser:nodejs /app ./
WORKDIR /app/${root}
USER appuser
CMD ${cmd}
`;
  }

  // static — serve the built output with a tiny static server.
  const dir = app.outputDir ?? (integrated ? out : `${root}/dist`);
  const spa = app.spa ?? framework === "vite";
  return `${header}

RUN npm install -g serve@14
COPY --from=build --chown=appuser:nodejs /app/${dir} ./dist
USER appuser
CMD ["serve"${spa ? `, "-s"` : ""}, "-l", "${port}", "dist"]
`;
}
