import { describe, it, expect, vi } from "vitest";
vi.mock("../src/services/settings.js", () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));
import { getSetting, setSetting } from "../src/services/settings.js";
import { hasActGrant, noActGrantReason, addActGrant } from "../src/browser/grants.js";

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

