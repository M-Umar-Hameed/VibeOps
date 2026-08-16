import { describe, it, expect, vi } from "vitest";
vi.mock("../src/services/settings.js", () => ({ getSetting: vi.fn() }));
import { getSetting } from "../src/services/settings.js";
import { hasActGrant, noActGrantReason } from "../src/browser/grants.js";

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
