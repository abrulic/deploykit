import {
  applyZoneSettings,
  type CfResponse,
  deployManagedWaf,
  getZone,
  setStaticAssetCacheRule,
  setZoneSetting,
  upsertDnsRecord,
} from "./cloudflare.js";
import type { DeploykitConfig } from "./config.js";
import {
  checkFlyCert,
  ensureFlyCert,
  type FlyCertInfo,
  type StepResult,
} from "./provision.js";

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
      if (env?.hostname)
        targets.push({ hostname: env.hostname, flyApp: env.name });
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
  if (!zoneRes.ok)
    return [
      { label: `Verify zone ${cf.zone}`, ok: false, detail: zoneRes.detail },
    ];
  if (!zoneRes.result) {
    return [
      {
        label: `Verify zone ${cf.zone}`,
        ok: false,
        detail:
          "zone not found on this account — check the domain and the token's zone access",
      },
    ];
  }
  const zoneId = zoneRes.result.id;
  const results: StepResult[] = [
    { label: `Verified Cloudflare zone ${cf.zone}`, ok: true },
  ];

  // 2. Per hostname: cert + DNS records.
  for (const target of domainTargets(config)) {
    const cert = await ensureFlyCert({
      hostname: target.hostname,
      app: target.flyApp,
      cwd,
    });
    if (!cert.ok) {
      results.push({
        label: `Fly cert ${target.hostname}`,
        ok: false,
        detail: cert.detail,
      });
      continue;
    }
    results.push({
      label: `Fly cert ${target.hostname}`,
      ok: true,
      detail: cert.configured ? "already issued" : undefined,
    });

    for (const r of await wireHostname({ token, zoneId, cert, target, cf }))
      results.push(r);
  }

  // 3. Zone-wide TLS settings.
  for (const r of await applyZoneSettings({ token, zoneId, cf }))
    results.push(r);

  // 4. Security baseline.
  if (cf.security) {
    results.push(
      step(
        "Security level = medium",
        await setZoneSetting({
          token,
          zoneId,
          key: "security_level",
          value: "medium",
        }),
      ),
    );
    results.push(
      bestEffort(
        "Managed WAF ruleset",
        await deployManagedWaf({ token, zoneId }),
      ),
    );
  }

  // 5. Caching.
  if (cf.cache) {
    results.push(
      bestEffort(
        "Cache rule: static assets",
        await setStaticAssetCacheRule({ token, zoneId }),
      ),
    );
    results.push(
      step(
        "Browser cache TTL = 30d",
        await setZoneSetting({
          token,
          zoneId,
          key: "browser_cache_ttl",
          value: 2592000,
        }),
      ),
    );
  }

  return results;
}

/**
 * Wire one hostname's DNS from what `flyctl certs` said it needs: the ownership
 * TXT (proves control to Fly behind the proxy), the user-facing record(s) that
 * route it to Fly (proxied per config), and the DNS-only ACME challenge Fly
 * validates against. Reports a clear failure when Fly returned no routable
 * target rather than silently wiring nothing.
 */
async function wireHostname({
  token,
  zoneId,
  cert,
  target,
  cf,
}: {
  token: string;
  zoneId: string;
  cert: FlyCertInfo;
  target: DomainTarget;
  cf: NonNullable<DeploykitConfig["cloudflare"]>;
}): Promise<StepResult[]> {
  const out: StepResult[] = [];

  // Ownership TXT (DNS-only). Fly can't see origin IPs through Cloudflare's
  // proxy, so this is how it confirms you control the domain.
  if (cert.ownership) {
    const res = await upsertDnsRecord({
      token,
      zoneId,
      type: "TXT",
      name: cert.ownership.name,
      content: cert.ownership.value,
      proxied: false,
    });
    out.push(step(`DNS ${cert.ownership.name} (ownership TXT, DNS-only)`, res));
  }

  // User-facing record(s): CNAME for a subdomain, A/AAAA for an apex.
  if (cert.records?.length) {
    for (const rec of cert.records) {
      const res = await upsertDnsRecord({
        token,
        zoneId,
        type: rec.type,
        name: rec.name,
        content: rec.content,
        proxied: cf.proxied,
      });
      out.push(
        step(
          `DNS ${rec.name} ${rec.type} → ${rec.content}${cf.proxied ? " (proxied)" : ""}`,
          res,
        ),
      );
    }
  } else {
    out.push({
      label: `DNS ${target.hostname}`,
      ok: false,
      detail:
        "Fly returned no DNS target for this hostname — the app may need `fly ips allocate` (apex) or a first deploy.",
    });
  }

  // ACME challenge (DNS-only) — the DNS-01 record that lets Fly issue the cert
  // without reaching the origin, which is essential when the record is proxied.
  if (cert.acmeChallenge) {
    const res = await upsertDnsRecord({
      token,
      zoneId,
      type: "CNAME",
      name: cert.acmeChallenge.name,
      content: cert.acmeChallenge.target,
      proxied: false,
    });
    out.push(
      step(`DNS ${cert.acmeChallenge.name} (cert validation, DNS-only)`, res),
    );
  }

  return out;
}

/** Seams for the issuance wait, injected so tests don't sleep or shell out. */
export interface AwaitCertsDeps {
  check: (input: {
    hostname: string;
    app: string;
    cwd: string;
  }) => Promise<{ configured: boolean; status?: string } | null>;
  sleep: (ms: number) => Promise<void>;
}

const defaultAwaitDeps: AwaitCertsDeps = {
  check: checkFlyCert,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Poll Fly until each custom-domain cert is issued, or a time budget runs out.
 * Certs validate asynchronously (usually a minute or two once the DNS records
 * resolve), so without this `init` reports success while HTTPS still 526s under
 * strict SSL. Certs that don't finish in time are reported as "still pending"
 * (not failed) — they keep validating in the background.
 */
export async function awaitCertIssuance({
  config,
  cwd,
  attempts = 20,
  intervalMs = 6000,
  deps,
}: {
  config: DeploykitConfig;
  cwd: string;
  attempts?: number;
  intervalMs?: number;
  deps?: Partial<AwaitCertsDeps>;
}): Promise<StepResult[]> {
  const d = { ...defaultAwaitDeps, ...deps };
  const targets = domainTargets(config);
  if (targets.length === 0) return [];

  const pending = new Map(targets.map((t) => [t.hostname, t]));
  const results = new Map<string, StepResult>();

  for (let i = 0; i < attempts && pending.size > 0; i++) {
    for (const [hostname, t] of [...pending]) {
      const st = await d.check({ hostname, app: t.flyApp, cwd });
      if (st?.configured) {
        results.set(hostname, {
          label: `Certificate ${hostname} issued`,
          ok: true,
        });
        pending.delete(hostname);
      }
    }
    if (pending.size > 0 && i < attempts - 1) await d.sleep(intervalMs);
  }

  for (const [hostname] of pending) {
    results.set(hostname, {
      label: `Certificate ${hostname}`,
      ok: true,
      detail:
        "still pending — Fly is validating; it should go live within a few minutes",
    });
  }
  // Preserve the original target order in the output.
  return targets
    .map((t) => results.get(t.hostname))
    .filter((r): r is StepResult => r !== undefined);
}

const step = (label: string, res: CfResponse<unknown>): StepResult => ({
  label,
  ok: res.ok,
  detail: res.ok ? undefined : res.detail,
});

/** For plan-dependent features: a failure reads as a skip, not a hard error. */
const bestEffort = (label: string, res: CfResponse<unknown>): StepResult =>
  res.ok
    ? { label, ok: true }
    : { label, ok: true, detail: `skipped: ${res.detail}` };
