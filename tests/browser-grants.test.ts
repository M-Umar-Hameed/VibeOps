import { describe, it, expect, vi } from "vitest";
vi.mock("../src/services/settings.js", () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));
import { getSetting, setSetting } from "../src/services/settings.js";
import { hasActGrant, noActGrantReason, addActGrant, allowOnce, takeOnce, ONCE_TTL_MS } from "../src/browser/grants.js";

const set = (v: string | null) => (getSetting as any).mockResolvedValue(v);

describe("hasActGrant", () => {
  it("false when unset", async () => { set(null); expect(await hasActGrant("https://github.com")).toBe(false); });
  it("false on bad json", async () => { set("{"); expect(await hasActGrant("https://github.com")).toBe(false); });
  it("false when not an array", async () => { set('{"origin":"x"}'); expect(await hasActGrant("https://github.com")).toBe(false); });
  it("true on matching act grant, case-insensitive", async () => {
    set(JSON.stringify([{ origin: "https://GitHub.com", mode: "act" }]));
    expect(await hasActGrant("https://github.com")).toBe(true);
  });
  it("false for read-only grant", async () => {
    set(JSON.stringify([{ origin: "https://github.com", mode: "read" }]));
    expect(await hasActGrant("https://github.com")).toBe(false);
  });
  it("false for a different origin", async () => {
    set(JSON.stringify([{ origin: "https://evil.com", mode: "act" }]));
    expect(await hasActGrant("https://github.com")).toBe(false);
  });
  it("reason names the origin", () => {
    expect(noActGrantReason("https://github.com")).toContain("https://github.com");
  });
});

describe("addActGrant", () => {
  it("appends {origin, mode:'act'} lowercased and leaves other origins intact", async () => {
    set(JSON.stringify([{ origin: "https://a.com", mode: "act" }]));
    await addActGrant("https://GitHub.com");
    const saved = (setSetting as any).mock.calls.at(-1)[1];
    expect(JSON.parse(saved)).toEqual([
      { origin: "https://a.com", mode: "act" },
      { origin: "https://github.com", mode: "act" },
    ]);
  });
  it("replaces a same-origin entry instead of duplicating", async () => {
    set(JSON.stringify([{ origin: "https://github.com", mode: "read" }]));
    await addActGrant("https://github.com");
    const saved = (setSetting as any).mock.calls.at(-1)[1];
    expect(JSON.parse(saved)).toEqual([{ origin: "https://github.com", mode: "act" }]);
  });
  it("writes a single-entry array when nothing was set", async () => {
    set(null);
    await addActGrant("https://github.com");
    const saved = (setSetting as any).mock.calls.at(-1)[1];
    expect(JSON.parse(saved)).toEqual([{ origin: "https://github.com", mode: "act" }]);
  });
});

describe("allowOnce / hasActGrant one-shot", () => {
  it("is consumed by the first hasActGrant call and gone on the second", async () => {
    set(null);
    allowOnce("s1", "https://github.com");
    expect(await hasActGrant("https://github.com", { sessionId: "s1" })).toBe(true);
    expect(await hasActGrant("https://github.com", { sessionId: "s1" })).toBe(false);
  });
  it("expires after ONCE_TTL_MS unused", () => {
    const now = Date.now();
    allowOnce("s1", "https://github.com", now);
    expect(takeOnce("s1", "https://github.com", now + ONCE_TTL_MS + 1)).toBe(false);
  });
  it("is scoped to the session it was granted for", async () => {
    set(null);
    allowOnce("s1", "https://github.com");
    expect(await hasActGrant("https://github.com", { sessionId: "s2" })).toBe(false);
  });
  it("origin is case-insensitive", async () => {
    set(null);
    allowOnce("s1", "https://GitHub.com");
    expect(await hasActGrant("https://github.com", { sessionId: "s1" })).toBe(true);
  });
  it("a persistent grant does not consume a pending once", async () => {
    set(JSON.stringify([{ origin: "https://github.com", mode: "act" }]));
    allowOnce("s1", "https://github.com");
    expect(await hasActGrant("https://github.com", { sessionId: "s1" })).toBe(true);
    expect(await hasActGrant("https://github.com", { sessionId: "s1" })).toBe(true);
  });
});

