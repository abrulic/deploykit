import type { AppConfig, DeploykitConfig } from "../config.js";
import { PM, baseStage, fileHeader, nodeImage, runnerHeader } from "./dockerfile-shared.js";
import type { GenerateAppFileInput } from "./types.js";

/**
 * Nx Dockerfile. Nx has no `turbo prune`, so we build the whole workspace and
 * copy the app's build output. Nx's default outputPath is `dist/<projectRoot>`;
 * if you've customized `outputPath`, adjust the copy paths below.
 */
export function nxDockerfile({ app, config }: GenerateAppFileInput) {
  const pm = PM[config.packageManager];
  const project = app.packageName; // the Nx project name (`nx build <project>`)

  const head = `${fileHeader({ root: app.root, base: baseStage(config) })}

# ── install + build (Nx) ─────────────────────────────────────────────────────
FROM base AS build
WORKDIR /app
COPY . .
RUN ${pm.install}
RUN ${pm.run} nx build ${project} --configuration=production
`;

  return head + "\n" + runner({ app, config }) + "\n";
}

function runner({ app, config }: { app: AppConfig; config: DeploykitConfig }) {
  const node = nodeImage(config);
  const pm = PM[config.packageManager];
  const { root, port, framework } = app;
  const out = `dist/${root}`; // Nx default output location
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

  if (framework === "remix" || framework === "node-server") {
    // Nx bundles the server + a pruned package.json into the output dir.
    return `${header}

COPY --from=build --chown=appuser:nodejs /app/${out} ./
RUN ${pm.installProd}
USER appuser
CMD ["node", "main.js"]
`;
  }

  // static | vite | astro — serve the built output with a tiny static server.
  const spa = framework === "vite" ? " -s" : "";
  return `${header}

RUN npm install -g serve@14
COPY --from=build --chown=appuser:nodejs /app/${out} ./dist
USER appuser
CMD ["serve"${spa ? `, "-s"` : ""}, "-l", "${port}", "dist"]
`;
}
