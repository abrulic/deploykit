import type { CloudflareConfig, MinTlsVersion } from "./config.js";

/**
 * Thin Cloudflare REST client. Uses the global `fetch` (Node ≥ 18) and a
 * scoped API token — no extra dependency. Every call returns a small result
 * object instead of throwing, so provisioning can report per-step and keep
 * going, matching the flyctl/gh helpers in provision.ts.
 */

const API = "https://api.cloudflare.com/client/v4";

export interface CfError {
  code: number;
  message: string;
}

export interface CfResponse<T> {
  ok: boolean;
  result?: T;
  /** Human-readable failure detail, when `ok` is false. */
  detail?: string;
  /** HTTP status of the response, when one was received. */
  status?: number;
}

export interface CfZone {
  id: string;
  name: string;
}

export interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
}

interface CfEnvelope<T> {
  success: boolean;
  errors: CfError[];
  result: T;
}

/** Low-level request. Never throws — network/HTTP errors become `{ ok: false }`. */
async function request<T>({
  token,
  method,
  path,
  body,
}: {
  token: string;
  method: string;
  path: string;
  body?: unknown;
}): Promise<CfResponse<T>> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // A stalled connection must not hang the CLI forever.
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, detail: `network error: ${String(err)}` };
  }

  let json: CfEnvelope<T> | undefined;
  try {
    json = (await res.json()) as CfEnvelope<T>;
  } catch {
    /* non-JSON body */
  }

  if (!res.ok || !json?.success) {
    const detail =
      json?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") ||
      `HTTP ${res.status}`;
    return { ok: false, detail, status: res.status };
  }
  return { ok: true, result: json.result, status: res.status };
}

/**
 * List every zone the token can see, for a pick-from-a-list prompt (mirrors the
 * Fly org picker). Paginates so accounts with more than a page of zones aren't
 * silently truncated. Returns null when the first call fails so callers fall
 * back to a free-text zone entry.
 */
export async function listCloudflareZones({
  token,
}: {
  token: string;
}): Promise<CfZone[] | null> {
  const perPage = 50;
  const zones: CfZone[] = [];
  // Hard cap of 20 pages (1000 zones) — plenty for a picker.
  for (let page = 1; page <= 20; page++) {
    const res = await request<CfZone[]>({
      token,
      method: "GET",
      path: `/zones?per_page=${perPage}&page=${page}`,
    });
    if (!res.ok || !res.result) return page === 1 ? null : zones;
    zones.push(...res.result.map((z) => ({ id: z.id, name: z.name })));
    if (res.result.length < perPage) break;
  }
  return zones;
}

/**
 * Look up a zone by exact name. Returns the zone when the token can see it
 * (this is the "you own/control the domain" check), null when it isn't found,
 * or an error detail when the API call itself failed.
 */
export async function getZone({
  token,
  name,
}: {
  token: string;
  name: string;
}): Promise<CfResponse<CfZone | null>> {
  const res = await request<CfZone[]>({
    token,
    method: "GET",
    path: `/zones?name=${encodeURIComponent(name)}`,
  });
  if (!res.ok) return { ok: false, detail: res.detail };
  const zone = res.result?.[0];
  return { ok: true, result: zone ? { id: zone.id, name: zone.name } : null };
}

/** Find an existing DNS record by type + exact name (for idempotent upserts). */
export async function findDnsRecord({
  token,
  zoneId,
  type,
  name,
}: {
  token: string;
  zoneId: string;
  type: string;
  name: string;
}): Promise<CfResponse<CfDnsRecord | null>> {
  const res = await request<CfDnsRecord[]>({
    token,
    method: "GET",
    path: `/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(name)}`,
  });
  if (!res.ok) return { ok: false, detail: res.detail };
  return { ok: true, result: res.result?.[0] ?? null };
}

/**
 * Create or update a DNS record so it matches the desired content/proxy state.
 * Idempotent: an identical existing record is left untouched.
 */
export async function upsertDnsRecord({
  token,
  zoneId,
  type,
  name,
  content,
  proxied,
}: {
  token: string;
  zoneId: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}): Promise<CfResponse<{ changed: boolean }>> {
  const existing = await findDnsRecord({ token, zoneId, type, name });
  if (!existing.ok) return { ok: false, detail: existing.detail };

  const body = { type, name, content, proxied, ttl: 1 }; // ttl:1 = "automatic"
  const current = existing.result;
  if (current) {
    if (current.content === content && (current.proxied ?? false) === proxied) {
      return { ok: true, result: { changed: false } };
    }
    const res = await request({
      token,
      method: "PUT",
      path: `/zones/${zoneId}/dns_records/${current.id}`,
      body,
    });
    return res.ok
      ? { ok: true, result: { changed: true } }
      : { ok: false, detail: res.detail };
  }

  const res = await request({
    token,
    method: "POST",
    path: `/zones/${zoneId}/dns_records`,
    body,
  });
  return res.ok
    ? { ok: true, result: { changed: true } }
    : { ok: false, detail: res.detail };
}

/** PATCH a single zone setting, e.g. `ssl` → "strict". */
export async function setZoneSetting({
  token,
  zoneId,
  key,
  value,
}: {
  token: string;
  zoneId: string;
  key: string;
  value: unknown;
}): Promise<CfResponse<unknown>> {
  return request({
    token,
    method: "PATCH",
    path: `/zones/${zoneId}/settings/${key}`,
    body: { value },
  });
}

/** A rule inside a phase entrypoint ruleset. Extra fields are passed through. */
interface CfRule {
  id?: string;
  action?: string;
  expression?: string;
  enabled?: boolean;
  action_parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

interface CfRuleset {
  id?: string;
  rules?: CfRule[];
}

/** Read-only fields the API returns on rules but rejects/ignores on writes. */
const stripReadOnly = ({ version, last_updated, ...rule }: CfRule): CfRule =>
  rule;

/**
 * Append a rule to a phase's entrypoint ruleset, **preserving every rule the
 * user already has there** — a bare PUT on the entrypoint replaces the whole
 * rule list, which for an existing zone would silently wipe their WAF/cache
 * rules. Flow: GET the entrypoint (404 → no ruleset yet, start empty; any
 * other failure → abort, never write blind), skip if an equivalent rule is
 * already present, else PUT back existing rules + ours.
 */
async function upsertPhaseRule({
  token,
  zoneId,
  phase,
  rule,
  isEquivalent,
}: {
  token: string;
  zoneId: string;
  phase: string;
  rule: CfRule;
  /** Whether an existing rule already does what `rule` would add. */
  isEquivalent: (existing: CfRule) => boolean;
}): Promise<CfResponse<{ changed: boolean }>> {
  const path = `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`;
  const current = await request<CfRuleset>({ token, method: "GET", path });

  let existing: CfRule[] = [];
  if (current.ok) {
    existing = current.result?.rules ?? [];
  } else if (current.status !== 404) {
    // Can't see the current rules — do NOT write, a PUT would replace them all.
    return {
      ok: false,
      detail: `couldn't read existing ${phase} rules: ${current.detail}`,
    };
  }

  if (existing.some(isEquivalent))
    return { ok: true, result: { changed: false } };

  const res = await request({
    token,
    method: "PUT",
    path,
    body: { rules: [...existing.map(stripReadOnly), rule] },
  });
  return res.ok
    ? { ok: true, result: { changed: true } }
    : { ok: false, detail: res.detail };
}

/** Cloudflare Managed Ruleset — a well-known, account-independent ID. */
const MANAGED_RULESET_ID = "efb7b8c949ac4650a09736fc376e9aee";

/**
 * Deploy Cloudflare's Managed Ruleset into the WAF phase, keeping any rules
 * already in the phase. Best-effort: on plans without managed WAF this returns
 * `ok: false` with the API detail, and the caller reports a clean skip rather
 * than failing the run.
 */
export async function deployManagedWaf({
  token,
  zoneId,
}: {
  token: string;
  zoneId: string;
}): Promise<CfResponse<unknown>> {
  return upsertPhaseRule({
    token,
    zoneId,
    phase: "http_request_firewall_managed",
    rule: {
      action: "execute",
      expression: "true",
      enabled: true,
      action_parameters: { id: MANAGED_RULESET_ID },
    },
    isEquivalent: (r) =>
      r.action === "execute" && r.action_parameters?.id === MANAGED_RULESET_ID,
  });
}

const STATIC_ASSET_EXPRESSION =
  '(starts_with(http.request.uri.path, "/assets/")) or ' +
  '(http.request.uri.path.extension in {"js" "css" "png" "jpg" "jpeg" "gif" "svg" "webp" "avif" "ico" "woff" "woff2" "ttf" "otf" "eot"})';

/**
 * Add an edge cache rule for static assets (long edge TTL for common asset
 * paths/extensions) via the cache-settings ruleset phase, keeping any rules
 * already in the phase. Best-effort.
 */
export async function setStaticAssetCacheRule({
  token,
  zoneId,
  edgeTtlSeconds = 2592000, // 30 days
}: {
  token: string;
  zoneId: string;
  edgeTtlSeconds?: number;
}): Promise<CfResponse<unknown>> {
  return upsertPhaseRule({
    token,
    zoneId,
    phase: "http_request_cache_settings",
    rule: {
      action: "set_cache_settings",
      expression: STATIC_ASSET_EXPRESSION,
      enabled: true,
      action_parameters: {
        cache: true,
        edge_ttl: { mode: "override_origin", default: edgeTtlSeconds },
        browser_ttl: { mode: "override_origin", default: edgeTtlSeconds },
      },
    },
    isEquivalent: (r) =>
      r.action === "set_cache_settings" &&
      r.expression === STATIC_ASSET_EXPRESSION,
  });
}

/** Apply the zone-wide settings from the config (SSL, HTTPS redirect, min TLS). */
export async function applyZoneSettings({
  token,
  zoneId,
  cf,
}: {
  token: string;
  zoneId: string;
  cf: CloudflareConfig;
}): Promise<{ label: string; ok: boolean; detail?: string }[]> {
  const steps: { key: string; label: string; value: unknown }[] = [
    { key: "ssl", label: `SSL = ${cf.ssl}`, value: cf.ssl },
    {
      key: "always_use_https",
      label: "Always Use HTTPS",
      value: onOff(cf.alwaysUseHttps),
    },
    {
      key: "min_tls_version",
      label: `Min TLS = ${cf.minTlsVersion}`,
      value: minTls(cf.minTlsVersion),
    },
  ];
  const results: { label: string; ok: boolean; detail?: string }[] = [];
  for (const s of steps) {
    const res = await setZoneSetting({
      token,
      zoneId,
      key: s.key,
      value: s.value,
    });
    results.push({
      label: s.label,
      ok: res.ok,
      detail: res.ok ? undefined : res.detail,
    });
  }
  return results;
}

const onOff = (b: boolean) => (b ? "on" : "off");
// The API expects the bare version string, e.g. "1.2".
const minTls = (v: MinTlsVersion) => v;
