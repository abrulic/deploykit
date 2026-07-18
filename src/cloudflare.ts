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
    return { ok: false, detail };
  }
  return { ok: true, result: json.result };
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
    return res.ok ? { ok: true, result: { changed: true } } : { ok: false, detail: res.detail };
  }

  const res = await request({
    token,
    method: "POST",
    path: `/zones/${zoneId}/dns_records`,
    body,
  });
  return res.ok ? { ok: true, result: { changed: true } } : { ok: false, detail: res.detail };
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

/**
 * Deploy Cloudflare's Managed Ruleset into the WAF phase. Best-effort: on
 * plans without managed WAF this returns `ok: false` with the API detail, and
 * the caller reports a clean skip rather than failing the run.
 */
export async function deployManagedWaf({
  token,
  zoneId,
}: {
  token: string;
  zoneId: string;
}): Promise<CfResponse<unknown>> {
  return request({
    token,
    method: "PUT",
    path: `/zones/${zoneId}/rulesets/phases/http_request_firewall_managed/entrypoint`,
    body: {
      rules: [
        { action: "execute", expression: "true", enabled: true,
          action_parameters: { id: "efb7b8c949ac4650a09736fc376e9aee" } }, // Cloudflare Managed Ruleset
      ],
    },
  });
}

/**
 * Add an edge cache rule for static assets (long edge TTL for common asset
 * paths/extensions) via the cache-settings ruleset phase. Best-effort.
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
  const expression =
    '(starts_with(http.request.uri.path, "/assets/")) or ' +
    '(http.request.uri.path.extension in {"js" "css" "png" "jpg" "jpeg" "gif" "svg" "webp" "avif" "ico" "woff" "woff2" "ttf" "otf" "eot"})';
  return request({
    token,
    method: "PUT",
    path: `/zones/${zoneId}/rulesets/phases/http_request_cache_settings/entrypoint`,
    body: {
      rules: [
        {
          action: "set_cache_settings",
          expression,
          enabled: true,
          action_parameters: {
            cache: true,
            edge_ttl: { mode: "override_origin", default: edgeTtlSeconds },
            browser_ttl: { mode: "override_origin", default: edgeTtlSeconds },
          },
        },
      ],
    },
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
    { key: "always_use_https", label: "Always Use HTTPS", value: onOff(cf.alwaysUseHttps) },
    { key: "min_tls_version", label: `Min TLS = ${cf.minTlsVersion}`, value: minTls(cf.minTlsVersion) },
  ];
  const results: { label: string; ok: boolean; detail?: string }[] = [];
  for (const s of steps) {
    const res = await setZoneSetting({ token, zoneId, key: s.key, value: s.value });
    results.push({ label: s.label, ok: res.ok, detail: res.ok ? undefined : res.detail });
  }
  return results;
}

const onOff = (b: boolean) => (b ? "on" : "off");
// The API expects the bare version string, e.g. "1.2".
const minTls = (v: MinTlsVersion) => v;
