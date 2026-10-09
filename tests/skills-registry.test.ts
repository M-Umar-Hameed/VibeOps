import { describe, it, expect, afterEach, vi } from "vitest";
import { searchRegistry } from "../src/skills/marketplace.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

function mockFetch(body: unknown, ok = true, status = 200) {
  globalThis.fetch = vi.fn(async () => ({
    ok, status, json: async () => body,
  })) as unknown as typeof fetch;
}

describe("searchRegistry", () => {
  it("maps registry rows to clone urls and keeps install ranking", async () => {
    mockFetch({ skills: [
      { name: "webapp-testing", source: "anthropics/skills", installs: 172108 },
      { name: "clerk-testing", source: "clerk/skills", installs: 43500 },
    ] });
    const r = await searchRegistry("testing");
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ name: "webapp-testing", source: "anthropics/skills", url: "https://github.com/anthropics/skills", installs: 172108 });
    expect(r[0].installs).toBeGreaterThan(r[1].installs);
  });

  it("drops rows whose source is not a valid owner/repo, so no hostile clone url is built", async () => {
    mockFetch({ skills: [
      { name: "ok", source: "owner/repo", installs: 1 },
      { name: "traversal", source: "../../etc", installs: 9 },
      { name: "host", source: "https://evil.com/x", installs: 9 },
      { name: "missing-name", source: "owner/repo" },
      { name: 5, source: "owner/repo", installs: 9 },
    ] });
    const r = await searchRegistry("x");
    expect(r.map((s) => s.source)).toEqual(["owner/repo", "owner/repo"]);
    expect(r.every((s) => s.url.startsWith("https://github.com/"))).toBe(true);
  });

  it("honours the limit", async () => {
    mockFetch({ skills: Array.from({ length: 10 }, (_, i) => ({ name: `s${i}`, source: `o/r${i}`, installs: i })) });
    expect(await searchRegistry("x", { limit: 3 })).toHaveLength(3);
  });

  it("throws on a non-ok response so the route can surface it", async () => {
    mockFetch({}, false, 503);
    await expect(searchRegistry("x")).rejects.toThrow(/HTTP 503/);
  });

  it("passes an owner filter through to the query", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (url: unknown) => {
      seenUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ skills: [] }) };
    }) as unknown as typeof fetch;
    await searchRegistry("test", { owner: "anthropics" });
    expect(seenUrl).toContain("owner=anthropics");
  });
});
