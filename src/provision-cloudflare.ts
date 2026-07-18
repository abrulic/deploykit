import type { DeploykitConfig } from "./config.js";
import {
  applyZoneSettings,
  type CfResponse,
  deployManagedWaf,
  getZone,
  setStaticAssetCacheRule,
  setZoneSetting,
  upsertDnsRecord,
} from "./cloudflare.js";
import { ensureFlyCert, type StepResult } from "./provision.js";

/** A staging/production hostname and the Fly app that serves it. */
export interface DomainTarget {
  hostname: string;
  flyApp: string;
}

/** Custom-domain targets across all apps (previews are excluded — they're ephemeral). */
export function domainTargets(config: DeploykitConfig): DomainTarget[] {
  const targets: DomainTarget[] = [];
  for (const app of Object.values(config.apps)) {
    for (const kind of ["staging", "production"] as const) {
      const env = app.environments[kind];
      if (env?.hostname) targets.push({ hostname: env.hostname, flyApp: env.name });
    }
  }
  return targets;
}

/**
 * Provision Cloudflare for the custom domains: verify the zone, issue Fly
 * certs, wire the DNS records (proxied main record + a DNS-only ACME challenge
 * record), then apply zone settings, security, and caching. Every step returns
 * a StepResult; best-effort steps (managed WAF, cache rules) report a clean
 * "skipped" rather than failing when the plan doesn't support them.
 */
export async function provisionCloudflare({
  config,
  token,
  cwd,
}: {
  config: DeploykitConfig;
  token: string;
  cwd: string;
}): Promise<StepResult[]> {
  const cf = config.cloudflare;
  if (!cf) return [];

  // 1. Verify the zone (this is the "you control the domain" check).
  const zoneRes = await getZone({ token, name: cf.zone });
  if (!zoneRes.ok) return [{ label: `Verify zone ${cf.zone}`, ok: false, detail: zoneRes.detail }];
  if (!zoneRes.result) {
    return [
      {
        label: `Verify zone ${cf.zone}`,
        ok: false,
        detail: "zone not found on this account — check the domain and the token's zone access",
      },
    ];
  }
  const zoneId = zoneRes.result.id;
  const results: StepResult[] = [{ label: `Verified Cloudflare zone ${cf.zone}`, ok: true }];

  // 2. Per hostname: cert + DNS records.
  for (const target of domainTargets(config)) {
    const cert = await ensureFlyCert({ hostname: target.hostname, app: target.flyApp, cwd });
    if (!cert.ok) {
      results.push({ label: `Fly cert ${target.hostname}`, ok: false, detail: cert.detail });
      continue;
    }
    results.push({ label: `Fly cert ${target.hostname}`, ok: true });

    const main = await upsertDnsRecord({
      token,
      zoneId,
      type: "CNAME",
      name: target.hostname,
      content: `${target.flyApp}.fly.dev`,
      proxied: cf.proxied,
    });
    results.push(
      step(
        `DNS ${target.hostname} → ${target.flyApp}.fly.dev${cf.proxied ? " (proxied)" : ""}`,
        main,
      ),
    );

    // The ACME challenge record must be DNS-only or Fly can't validate the cert.
    if (cert.validationHostname && cert.validationTarget) {
      const acme = await upsertDnsRecord({
        token,
        zoneId,
        type: "CNAME",
        name: cert.validationHostname,
        content: cert.validationTarget,
        proxied: false,
      });
      results.push(step(`DNS ${cert.validationHostname} (cert validation, DNS-only)`, acme));
    }
  }

  // 3. Zone-wide TLS settings.
  for (const r of await applyZoneSettings({ token, zoneId, cf })) results.push(r);

  // 4. Security baseline.
  if (cf.security) {
    results.push(
      step("Security level = medium", await setZoneSetting({ token, zoneId, key: "security_level", value: "medium" })),
    );
    results.push(bestEffort("Managed WAF ruleset", await deployManagedWaf({ token, zoneId })));
  }

  // 5. Caching.
  if (cf.cache) {
    results.push(bestEffort("Cache rule: static assets", await setStaticAssetCacheRule({ token, zoneId })));
    results.push(
      step("Browser cache TTL = 30d", await setZoneSetting({ token, zoneId, key: "browser_cache_ttl", value: 2592000 })),
    );
  }

  return results;
}

const step = (label: string, res: CfResponse<unknown>): StepResult => ({
  label,
  ok: res.ok,
  detail: res.ok ? undefined : res.detail,
});

/** For plan-dependent features: a failure reads as a skip, not a hard error. */
const bestEffort = (label: string, res: CfResponse<unknown>): StepResult =>
  res.ok ? { label, ok: true } : { label, ok: true, detail: `skipped: ${res.detail}` };
