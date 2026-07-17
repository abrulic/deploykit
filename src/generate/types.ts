import type { AppConfig, DeploykitConfig } from "../config.js";

/** Input for per-app file generators (Dockerfile, fly.toml). */
export interface GenerateAppFileInput {
  name: string;
  app: AppConfig;
  config: DeploykitConfig;
}
