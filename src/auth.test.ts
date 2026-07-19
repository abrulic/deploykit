import { describe, expect, it, vi } from "vitest";
import { type AuthDeps, ensureLoggedIn, FLY_TOOL, GH_TOOL } from "./auth.js";

/** A deps double whose calls we can assert on; each seam overridable per test. */
function deps(over: Partial<AuthDeps> = {}) {
  const warn = vi.fn();
  const success = vi.fn();
  const info = vi.fn();
  const base: AuthDeps = {
    exists: vi.fn(async () => true),
    confirm: vi.fn(async () => true),
    runLogin: vi.fn(async () => 0),
    verify: vi.fn(async () => true),
    log: { warn, success, info },
    ...over,
  };
  return { d: base, warn, success, info };
}

describe("ensureLoggedIn", () => {
  it("is a no-op when already authenticated", async () => {
    const { d } = deps();
    const ok = await ensureLoggedIn({
      tool: GH_TOOL,
      ready: true,
      cwd: ".",
      interactive: true,
      deps: d,
    });
    expect(ok).toBe(true);
    expect(d.exists).not.toHaveBeenCalled();
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.runLogin).not.toHaveBeenCalled();
  });

  it("warns and skips when the CLI isn't installed", async () => {
    const { d, warn } = deps({ exists: vi.fn(async () => false) });
    const ok = await ensureLoggedIn({
      tool: FLY_TOOL,
      ready: false,
      cwd: ".",
      interactive: true,
      deps: d,
    });
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("isn't installed"),
    );
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.runLogin).not.toHaveBeenCalled();
  });

  it("warns with the login command in non-interactive mode (never prompts)", async () => {
    const { d, warn } = deps();
    const ok = await ensureLoggedIn({
      tool: FLY_TOOL,
      ready: false,
      cwd: ".",
      interactive: false,
      deps: d,
    });
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("flyctl auth login"),
    );
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.runLogin).not.toHaveBeenCalled();
  });

  it("skips (no login) when the user declines the prompt", async () => {
    const { d, info } = deps({ confirm: vi.fn(async () => false) });
    const ok = await ensureLoggedIn({
      tool: GH_TOOL,
      ready: false,
      cwd: ".",
      interactive: true,
      deps: d,
    });
    expect(ok).toBe(false);
    expect(d.runLogin).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("Skipping GitHub login"),
    );
  });

  it("drives the login and reports success when it verifies", async () => {
    const { d, success } = deps();
    const ok = await ensureLoggedIn({
      tool: GH_TOOL,
      ready: false,
      cwd: "/repo",
      interactive: true,
      deps: d,
    });
    expect(ok).toBe(true);
    expect(d.runLogin).toHaveBeenCalledWith(GH_TOOL, "/repo");
    expect(d.verify).toHaveBeenCalledWith(GH_TOOL, "/repo");
    expect(success).toHaveBeenCalledWith(
      expect.stringContaining("Logged in to GitHub"),
    );
  });

  it("treats a non-zero login exit as failure and doesn't verify", async () => {
    const { d, warn } = deps({ runLogin: vi.fn(async () => 1) });
    const ok = await ensureLoggedIn({
      tool: FLY_TOOL,
      ready: false,
      cwd: ".",
      interactive: true,
      deps: d,
    });
    expect(ok).toBe(false);
    expect(d.verify).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("didn't complete"),
    );
  });

  it("stays false when login exits 0 but the status check still fails", async () => {
    const { d, warn } = deps({ verify: vi.fn(async () => false) });
    const ok = await ensureLoggedIn({
      tool: FLY_TOOL,
      ready: false,
      cwd: ".",
      interactive: true,
      deps: d,
    });
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("still looks unauthenticated"),
    );
  });
});
