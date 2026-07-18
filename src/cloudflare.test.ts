import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findDnsRecord,
  getZone,
  listCloudflareZones,
  setZoneSetting,
  upsertDnsRecord,
} from "./cloudflare.js";

/** Build a fake fetch that returns the given Cloudflare envelope + HTTP status. */
function mockFetch(
  handler: (url: string, init: RequestInit) => {
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
      fetchSpy = mockFetch(() => ({ body: ok([{ id: "z1", name: "example.com" }]) }));
      vi.stubGlobal("fetch", fetchSpy);
      const res = await getZone({ token: TOKEN, name: "example.com" });
      expect(res.ok).toBe(true);
      expect(res.result).toEqual({ id: "z1", name: "example.com" });
      const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
      expect(url).toContain("/zones?name=example.com");
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
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
        body: { success: false, errors: [{ code: 9109, message: "Invalid token" }], result: null },
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
        token: TOKEN, zoneId: "z1", type: "CNAME", name: "app.example.com",
        content: "app-prod.fly.dev", proxied: true,
      });
      expect(res).toEqual({ ok: true, result: { changed: true } });
      const post = fetchSpy.mock.calls.find(([, i]) => (i as RequestInit).method === "POST")!;
      expect(post[0]).toContain("/zones/z1/dns_records");
      expect(JSON.parse((post[1] as RequestInit).body as string)).toMatchObject({
        type: "CNAME", name: "app.example.com", content: "app-prod.fly.dev", proxied: true,
      });
    });

    it("leaves an identical record untouched (no write)", async () => {
      fetchSpy = mockFetch((_url, init) => {
        if (init.method === "GET")
          return { body: ok([{ id: "r1", type: "CNAME", name: "app.example.com", content: "app-prod.fly.dev", proxied: true }]) };
        return { body: ok({ id: "r1" }) };
      });
      vi.stubGlobal("fetch", fetchSpy);
      const res = await upsertDnsRecord({
        token: TOKEN, zoneId: "z1", type: "CNAME", name: "app.example.com",
        content: "app-prod.fly.dev", proxied: true,
      });
      expect(res).toEqual({ ok: true, result: { changed: false } });
      expect(fetchSpy.mock.calls.some(([, i]) => ["POST", "PUT"].includes((i as RequestInit).method as string))).toBe(false);
    });

    it("updates a record whose proxied state differs (PUT)", async () => {
      fetchSpy = mockFetch((_url, init) => {
        if (init.method === "GET")
          return { body: ok([{ id: "r1", type: "CNAME", name: "app.example.com", content: "app-prod.fly.dev", proxied: false }]) };
        return { body: ok({ id: "r1" }) };
      });
      vi.stubGlobal("fetch", fetchSpy);
      const res = await upsertDnsRecord({
        token: TOKEN, zoneId: "z1", type: "CNAME", name: "app.example.com",
        content: "app-prod.fly.dev", proxied: true,
      });
      expect(res).toEqual({ ok: true, result: { changed: true } });
      const put = fetchSpy.mock.calls.find(([, i]) => (i as RequestInit).method === "PUT")!;
      expect(put[0]).toContain("/zones/z1/dns_records/r1");
    });
  });

  describe("setZoneSetting", () => {
    it("PATCHes the setting value", async () => {
      fetchSpy = mockFetch(() => ({ body: ok({ id: "ssl", value: "strict" }) }));
      vi.stubGlobal("fetch", fetchSpy);
      const res = await setZoneSetting({ token: TOKEN, zoneId: "z1", key: "ssl", value: "strict" });
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
      const res = await findDnsRecord({ token: TOKEN, zoneId: "z1", type: "CNAME", name: "x.example.com" });
      expect(res).toEqual({ ok: true, result: null });
    });
  });

  describe("listCloudflareZones", () => {
    it("returns the account's zones (name + id)", async () => {
      fetchSpy = mockFetch(() => ({
        body: ok([{ id: "z1", name: "a.com" }, { id: "z2", name: "b.com" }]),
      }));
      vi.stubGlobal("fetch", fetchSpy);
      const zones = await listCloudflareZones({ token: TOKEN });
      expect(zones).toEqual([{ id: "z1", name: "a.com" }, { id: "z2", name: "b.com" }]);
      expect(fetchSpy.mock.calls[0]![0]).toContain("/zones?per_page=50");
    });

    it("returns null when the call fails (so callers fall back to typing)", async () => {
      fetchSpy = mockFetch(() => ({
        status: 403,
        body: { success: false, errors: [{ code: 9109, message: "bad token" }], result: null },
      }));
      vi.stubGlobal("fetch", fetchSpy);
      expect(await listCloudflareZones({ token: TOKEN })).toBeNull();
    });
  });
});
