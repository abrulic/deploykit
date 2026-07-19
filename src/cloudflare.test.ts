import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deployManagedWaf,
  findDnsRecord,
  getZone,
  listCloudflareZones,
  setStaticAssetCacheRule,
  setZoneSetting,
  upsertDnsRecord,
} from "./cloudflare.js";

/** Build a fake fetch that returns the given Cloudflare envelope + HTTP status. */
function mockFetch(
  handler: (
    url: string,
    init: RequestInit,
  ) => {
    status?: number;
    body: unknown;
  },
) {
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    const { status = 200, body } = handler(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  });
}

const ok = <T>(result: T) => ({ success: true, errors: [], result });

const TOKEN = "cf-token";

describe("cloudflare client", () => {
  let fetchSpy: ReturnType<typeof mockFetch>;
  beforeEach(() => {
    fetchSpy = mockFetch(() => ({ body: ok(null) }));
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  describe("getZone", () => {
    it("returns the zone when the token can see it", async () => {
      fetchSpy = mockFetch(() => ({
        body: ok([{ id: "z1", name: "example.com" }]),
      }));
      vi.stubGlobal("fetch", fetchSpy);
      const res = await getZone({ token: TOKEN, name: "example.com" });
      expect(res.ok).toBe(true);
      expect(res.result).toEqual({ id: "z1", name: "example.com" });
      const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
      expect(url).toContain("/zones?name=example.com");
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${TOKEN}`,
      );
    });

    it("returns null when the zone isn't found", async () => {
      fetchSpy = mockFetch(() => ({ body: ok([]) }));
      vi.stubGlobal("fetch", fetchSpy);
      const res = await getZone({ token: TOKEN, name: "nope.com" });
      expect(res).toEqual({ ok: true, result: null });
    });

    it("surfaces API errors", async () => {
      fetchSpy = mockFetch(() => ({
        status: 403,
        body: {
          success: false,
          errors: [{ code: 9109, message: "Invalid token" }],
          result: null,
        },
      }));
      vi.stubGlobal("fetch", fetchSpy);
      const res = await getZone({ token: TOKEN, name: "example.com" });
      expect(res.ok).toBe(false);
      expect(res.detail).toContain("Invalid token");
    });
  });

  describe("upsertDnsRecord", () => {
    it("creates the record when none exists (POST)", async () => {
      fetchSpy = mockFetch((_url, init) => {
        if (init.method === "GET") return { body: ok([]) };
        return { body: ok({ id: "r1" }) };
      });
      vi.stubGlobal("fetch", fetchSpy);
      const res = await upsertDnsRecord({
        token: TOKEN,
        zoneId: "z1",
        type: "CNAME",
        name: "app.example.com",
        content: "app-prod.fly.dev",
        proxied: true,
      });
      expect(res).toEqual({ ok: true, result: { changed: true } });
      const post = fetchSpy.mock.calls.find(
        ([, i]) => (i as RequestInit).method === "POST",
      )!;
      expect(post[0]).toContain("/zones/z1/dns_records");
      expect(JSON.parse((post[1] as RequestInit).body as string)).toMatchObject(
        {
          type: "CNAME",
          name: "app.example.com",
          content: "app-prod.fly.dev",
          proxied: true,
        },
      );
    });

    it("leaves an identical record untouched (no write)", async () => {
      fetchSpy = mockFetch((_url, init) => {
        if (init.method === "GET")
          return {
            body: ok([
              {
                id: "r1",
                type: "CNAME",
                name: "app.example.com",
                content: "app-prod.fly.dev",
                proxied: true,
              },
            ]),
          };
        return { body: ok({ id: "r1" }) };
      });
      vi.stubGlobal("fetch", fetchSpy);
      const res = await upsertDnsRecord({
        token: TOKEN,
        zoneId: "z1",
        type: "CNAME",
        name: "app.example.com",
        content: "app-prod.fly.dev",
        proxied: true,
      });
      expect(res).toEqual({ ok: true, result: { changed: false } });
      expect(
        fetchSpy.mock.calls.some(([, i]) =>
          ["POST", "PUT"].includes((i as RequestInit).method as string),
        ),
      ).toBe(false);
    });

    it("updates a record whose proxied state differs (PUT)", async () => {
      fetchSpy = mockFetch((_url, init) => {
        if (init.method === "GET")
          return {
            body: ok([
              {
                id: "r1",
                type: "CNAME",
                name: "app.example.com",
                content: "app-prod.fly.dev",
                proxied: false,
              },
            ]),
          };
        return { body: ok({ id: "r1" }) };
      });
      vi.stubGlobal("fetch", fetchSpy);
      const res = await upsertDnsRecord({
        token: TOKEN,
        zoneId: "z1",
        type: "CNAME",
        name: "app.example.com",
        content: "app-prod.fly.dev",
        proxied: true,
      });
      expect(res).toEqual({ ok: true, result: { changed: true } });
      const put = fetchSpy.mock.calls.find(
        ([, i]) => (i as RequestInit).method === "PUT",
      )!;
      expect(put[0]).toContain("/zones/z1/dns_records/r1");
    });
  });

  describe("setZoneSetting", () => {
    it("PATCHes the setting value", async () => {
      fetchSpy = mockFetch(() => ({
        body: ok({ id: "ssl", value: "strict" }),
      }));
      vi.stubGlobal("fetch", fetchSpy);
      const res = await setZoneSetting({
        token: TOKEN,
        zoneId: "z1",
        key: "ssl",
        value: "strict",
      });
      expect(res.ok).toBe(true);
      const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
      expect(url).toContain("/zones/z1/settings/ssl");
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body as string)).toEqual({ value: "strict" });
    });
  });

  describe("findDnsRecord", () => {
    it("returns null when there's no match", async () => {
      fetchSpy = mockFetch(() => ({ body: ok([]) }));
      vi.stubGlobal("fetch", fetchSpy);
      const res = await findDnsRecord({
        token: TOKEN,
        zoneId: "z1",
        type: "CNAME",
        name: "x.example.com",
      });
      expect(res).toEqual({ ok: true, result: null });
    });
  });

  describe("phase entrypoint rules (WAF / cache)", () => {
    const MANAGED_ID = "efb7b8c949ac4650a09736fc376e9aee";
    const userRule = {
      id: "user1",
      action: "block",
      expression: "ip.src eq 1.2.3.4",
      enabled: true,
      version: "3", // read-only field the API returns — must be stripped on write
      last_updated: "2026-01-01T00:00:00Z",
    };

    it("preserves the user's existing rules when appending (no clobber)", async () => {
      fetchSpy = mockFetch((_url, init) => {
        if (init.method === "GET")
          return { body: ok({ id: "rs1", rules: [userRule] }) };
        return { body: ok({ id: "rs1" }) };
      });
      vi.stubGlobal("fetch", fetchSpy);
      const res = await deployManagedWaf({ token: TOKEN, zoneId: "z1" });
      expect(res).toMatchObject({ ok: true, result: { changed: true } });
      const put = fetchSpy.mock.calls.find(
        ([, i]) => (i as RequestInit).method === "PUT",
      )!;
      const body = JSON.parse((put[1] as RequestInit).body as string) as {
        rules: Record<string, unknown>[];
      };
      expect(body.rules).toHaveLength(2);
      expect(body.rules[0]).toMatchObject({ id: "user1", action: "block" });
      expect(body.rules[0]).not.toHaveProperty("version");
      expect(body.rules[0]).not.toHaveProperty("last_updated");
      expect(body.rules[1]).toMatchObject({
        action: "execute",
        action_parameters: { id: MANAGED_ID },
      });
    });

    it("skips the write when an equivalent rule already exists", async () => {
      const managed = {
        id: "r9",
        action: "execute",
        expression: "true",
        action_parameters: { id: MANAGED_ID },
      };
      fetchSpy = mockFetch(() => ({
        body: ok({ id: "rs1", rules: [userRule, managed] }),
      }));
      vi.stubGlobal("fetch", fetchSpy);
      const res = await deployManagedWaf({ token: TOKEN, zoneId: "z1" });
      expect(res).toMatchObject({ ok: true, result: { changed: false } });
      expect(
        fetchSpy.mock.calls.some(
          ([, i]) => (i as RequestInit).method === "PUT",
        ),
      ).toBe(false);
    });

    it("treats a 404 (no entrypoint yet) as an empty rule list", async () => {
      fetchSpy = mockFetch((_url, init) => {
        if (init.method === "GET")
          return {
            status: 404,
            body: {
              success: false,
              errors: [{ code: 20211, message: "not found" }],
              result: null,
            },
          };
        return { body: ok({ id: "rs1" }) };
      });
      vi.stubGlobal("fetch", fetchSpy);
      const res = await setStaticAssetCacheRule({ token: TOKEN, zoneId: "z1" });
      expect(res).toMatchObject({ ok: true, result: { changed: true } });
      const put = fetchSpy.mock.calls.find(
        ([, i]) => (i as RequestInit).method === "PUT",
      )!;
      const body = JSON.parse((put[1] as RequestInit).body as string) as {
        rules: Record<string, unknown>[];
      };
      expect(body.rules).toHaveLength(1);
      expect(body.rules[0]).toMatchObject({ action: "set_cache_settings" });
    });

    it("refuses to write when the existing rules can't be read (non-404)", async () => {
      fetchSpy = mockFetch((_url, init) => {
        if (init.method === "GET")
          return {
            status: 403,
            body: {
              success: false,
              errors: [{ code: 10000, message: "auth" }],
              result: null,
            },
          };
        return { body: ok({ id: "rs1" }) };
      });
      vi.stubGlobal("fetch", fetchSpy);
      const res = await deployManagedWaf({ token: TOKEN, zoneId: "z1" });
      expect(res.ok).toBe(false);
      expect(res.detail).toContain("couldn't read existing");
      expect(
        fetchSpy.mock.calls.some(
          ([, i]) => (i as RequestInit).method === "PUT",
        ),
      ).toBe(false);
    });
  });

  describe("listCloudflareZones", () => {
    it("returns the account's zones (name + id)", async () => {
      fetchSpy = mockFetch(() => ({
        body: ok([
          { id: "z1", name: "a.com" },
          { id: "z2", name: "b.com" },
        ]),
      }));
      vi.stubGlobal("fetch", fetchSpy);
      const zones = await listCloudflareZones({ token: TOKEN });
      expect(zones).toEqual([
        { id: "z1", name: "a.com" },
        { id: "z2", name: "b.com" },
      ]);
      expect(fetchSpy.mock.calls[0]![0]).toContain("/zones?per_page=50&page=1");
      // A partial page means no more zones — exactly one request.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("paginates past a full page instead of truncating at 50", async () => {
      const fullPage = Array.from({ length: 50 }, (_, i) => ({
        id: `z${i}`,
        name: `site${i}.com`,
      }));
      fetchSpy = mockFetch((url) => ({
        body: ok(
          url.includes("page=1")
            ? fullPage
            : [{ id: "z50", name: "site50.com" }],
        ),
      }));
      vi.stubGlobal("fetch", fetchSpy);
      const zones = await listCloudflareZones({ token: TOKEN });
      expect(zones).toHaveLength(51);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[1]![0]).toContain("page=2");
    });

    it("sends an abort signal so a stalled connection can't hang the CLI", async () => {
      fetchSpy = mockFetch(() => ({ body: ok([]) }));
      vi.stubGlobal("fetch", fetchSpy);
      await listCloudflareZones({ token: TOKEN });
      const init = fetchSpy.mock.calls[0]![1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("returns null when the call fails (so callers fall back to typing)", async () => {
      fetchSpy = mockFetch(() => ({
        status: 403,
        body: {
          success: false,
          errors: [{ code: 9109, message: "bad token" }],
          result: null,
        },
      }));
      vi.stubGlobal("fetch", fetchSpy);
      expect(await listCloudflareZones({ token: TOKEN })).toBeNull();
    });
  });
});
