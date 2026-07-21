import type { DeploykitConfig, EnvironmentKind, Trigger } from "./config.js";

/** Public address of a Fly app on its default domain. */
export const flyUrl = (flyApp: string) => `https://${flyApp}.fly.dev`;

/** Environments in deploy order — how every destination list is sorted. */
export const ENV_ORDER: EnvironmentKind[] = [
  "preview",
  "staging",
  "production",
];

/** Human phrasing for what makes an environment deploy. */
export const TRIGGER_LABEL: Record<Trigger, string> = {
  pr: "on every pull request",
  "push:main": "on merge to main",
  manual: "manual approval",
};

/** One app environment resolved to the place it actually runs. */
export interface Destination {
  /** Logical app name (the config key), e.g. "web". */
  app: string;
  kind: EnvironmentKind;
  /** Fly app name; previews keep the `{pr}` placeholder. */
  flyApp: string;
  /** Final public URL — the custom domain when set, else `*.fly.dev`. */
  url: string;
  /** Custom domain, when this environment serves one. */
  hostname?: string;
  trigger: Trigger;
}

/** Every configured environment of one app, in deploy order. */
export function destinationsForApp({
  app,
  config,
}: {
  app: string;
  config: DeploykitConfig;
}): Destination[] {
  const cfg = config.apps[app];
  if (!cfg) return [];
  const out: Destination[] = [];
  for (const kind of ENV_ORDER) {
    const env = cfg.environments[kind];
    if (!env) continue;
    out.push({
      app,
      kind,
      flyApp: env.name,
      url: env.hostname ? `https://${env.hostname}` : flyUrl(env.name),
      hostname: env.hostname,
      trigger: env.trigger,
    });
  }
  return out;
}

/**
 * Every environment of every app — the shared model behind the end-of-run
 * terminal map and the generated `DEPLOYMENTS.md`, so the two can't disagree.
 */
export function destinations(config: DeploykitConfig): Destination[] {
  return Object.keys(config.apps).flatMap((app) =>
    destinationsForApp({ app, config }),
  );
}
