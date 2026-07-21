import { describe, expect, it } from "vitest";
import { parseObjectLiteral } from "./config-literal.js";

const parse = (source: string) => parseObjectLiteral({ source });

describe("parseObjectLiteral", () => {
  it("reads plain JSON", () => {
    const res = parse('{ "tool": "turbo", "port": 3000, "ok": true }');
    expect(res.error).toBeUndefined();
    expect(res.value).toEqual({ tool: "turbo", port: 3000, ok: true });
  });

  it("reads what a formatter leaves behind: bare keys, single quotes, trailing commas", () => {
    const res = parse(`{
      tool: 'turbo',
      provider: { type: 'fly', region: 'iad', regions: ['iad', 'lhr'], },
      apps: {},
    }`);
    expect(res.error).toBeUndefined();
    expect(res.value).toEqual({
      tool: "turbo",
      provider: { type: "fly", region: "iad", regions: ["iad", "lhr"] },
      apps: {},
    });
  });

  it("skips line and block comments", () => {
    const res = parse(`{
      // bumped for the new runtime
      "nodeVersion": "22", // inline, after a value
      /* multi
         line */
      "tool": "turbo"
    }`);
    expect(res.value).toEqual({ nodeVersion: "22", tool: "turbo" });
  });

  it("never treats comment markers inside a string as a comment", () => {
    const res = parse(`{
      "url": "https://example.com//x",
      "glob": "apps/**/*.ts",
      "block": "a /* not a comment */ b"
    }`);
    expect(res.value).toEqual({
      url: "https://example.com//x",
      glob: "apps/**/*.ts",
      block: "a /* not a comment */ b",
    });
  });

  it("stops at the end of the literal and ignores what follows", () => {
    const source = 'export default defineConfig({ "tool": "turbo" });\n';
    const res = parseObjectLiteral({
      source,
      from: source.indexOf("(") + 1,
    });
    expect(res.value).toEqual({ tool: "turbo" });
  });

  it("handles nested structures, negative and exponent numbers, and null", () => {
    const res = parse(`{
      "apps": { "web": { "ports": [3000, -1, 1e3, 1.5], "spa": null } }
    }`);
    expect(res.value).toEqual({
      apps: { web: { ports: [3000, -1, 1000, 1.5], spa: null } },
    });
  });

  it("decodes escape sequences", () => {
    const res = parse(String.raw`{ "s": "a\nb\t\"c\"é\\d\/e" }`);
    expect(res.value).toEqual({ s: 'a\nb\t"c"é\\d/e' });
  });

  it("reads a template string with no placeholders", () => {
    expect(parse("{ name: `web-staging` }").value).toEqual({
      name: "web-staging",
    });
  });

  it("rejects a template placeholder rather than emitting it literally", () => {
    const res = parse("{ name: `web-${env}` }");
    expect(res.value).toBeUndefined();
    expect(res.error).toContain("template placeholders");
  });

  it("rejects an identifier value instead of guessing", () => {
    const res = parse("{ region: region }");
    expect(res.error).toContain("no variables");
  });

  it("rejects a spread", () => {
    expect(parse("{ ...base, tool: 'turbo' }").error).toBeDefined();
  });

  it("rejects a call expression", () => {
    expect(parse('{ tool: readTool("turbo") }').error).toBeDefined();
  });

  it("reports the line a problem is on", () => {
    const res = parse(`{
      "tool": "turbo",
      "port": oops
    }`);
    expect(res.error).toContain("line 3");
  });

  it("rejects an unterminated string, object, or block comment", () => {
    expect(parse('{ "tool": "turbo }').error).toContain("unterminated string");
    expect(parse('{ "tool": "turbo"').error).toContain('expected "," or "}"');
    expect(parse('{ /* open "tool": "turbo" }').error).toContain(
      "unterminated block comment",
    );
  });

  it("rejects a non-object", () => {
    expect(parse('["turbo"]').error).toContain("expected an object literal");
  });

  it("keeps a __proto__ key as an own property, off the prototype chain", () => {
    const res = parse('{ "__proto__": { "polluted": true } }');
    expect(res.error).toBeUndefined();
    expect({}).not.toHaveProperty("polluted");
    expect(Object.getPrototypeOf(res.value)).toBe(Object.prototype);
  });
});
