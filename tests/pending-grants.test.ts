import { describe, it, expect } from "vitest";
import { recordBrowserCall, drainBrowserCalls } from "../src/browser/pending-grants.js";

describe("pending-grants", () => {
  it("drains an actor's calls since a timestamp, leaving other actors' untouched", () => {
    recordBrowserCall("A", { name: "browser_snapshot", summary: "ok" }, 100);
    recordBrowserCall("A", { name: "browser_act", summary: "refused: no grant", grantOrigin: "https://b.test" }, 200);
    recordBrowserCall("B", { name: "browser_snapshot", summary: "ok" }, 150);

    const drained = drainBrowserCalls("A", 0, 1000);
    expect(drained).toEqual([
      { actorId: "A", name: "browser_snapshot", summary: "ok", at: 100 },
      { actorId: "A", name: "browser_act", summary: "refused: no grant", grantOrigin: "https://b.test", at: 200 },
    ]);

    // A second drain of A is empty; B's call is still there.
    expect(drainBrowserCalls("A", 0, 1000)).toEqual([]);
    expect(drainBrowserCalls("B", 0, 1000)).toEqual([
      { actorId: "B", name: "browser_snapshot", summary: "ok", at: 150 },
    ]);
  });

  it("drops a call older than the TTL", () => {
    recordBrowserCall("A", { name: "browser_snapshot", summary: "ok" }, 0);
    const now = 30 * 60 * 1000 + 1;
    expect(drainBrowserCalls("A", 0, now)).toEqual([]);
  });

  it("since excludes earlier entries", () => {
    recordBrowserCall("A", { name: "browser_snapshot", summary: "ok" }, 100);
    recordBrowserCall("A", { name: "browser_snapshot", summary: "ok" }, 500);
    expect(drainBrowserCalls("A", 300, 1000)).toEqual([
      { actorId: "A", name: "browser_snapshot", summary: "ok", at: 500 },
    ]);
    // The earlier entry is still pending (since excluded it, not TTL).
    expect(drainBrowserCalls("A", 0, 1000)).toEqual([
      { actorId: "A", name: "browser_snapshot", summary: "ok", at: 100 },
    ]);
  });
});
