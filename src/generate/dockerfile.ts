import { nxDockerfile } from "./dockerfile-nx.js";
import { turboDockerfile } from "./dockerfile-turbo.js";
import type { GenerateAppFileInput } from "./types.js";

/**
 * A multi-stage, monorepo-aware Dockerfile — dispatched by the detected tool.
 * Turbo uses `turbo prune`; Nx builds the workspace and copies the app output.
 */
export function generateDockerfile(input: GenerateAppFileInput) {
  return input.config.tool === "nx"
    ? nxDockerfile(input)
    : turboDockerfile(input);
}
