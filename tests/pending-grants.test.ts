import { describe, it, expect } from "vitest";
import { recordRefusal, drainRefusals } from "../src/browser/pending-grants.js";

describe("pending-grants", () => {
  it("drains an actor's refusals since a timestamp, leaving other actors' untouched", () => {
    recordRefusal("A", "https://a.test", "no grant", 100);
    recordRefusal("A", "https://b.test", "no grant", 200);
    recordRefusal("B", "https://c.test", "no grant", 150);

    const drained = drainRefusals("A", 0, 1000);
    expect(drained).toEqual([
      { actorId: "A", origin: "https://a.test", reason: "no grant", at: 100 },
      { actorId: "A", origin: "https://b.test", reason: "no grant", at: 200 },
    ]);

    // A second drain of A is empty; B's refusal is still there.
    expect(drainRefusals("A", 0, 1000)).toEqual([]);
    expect(drainRefusals("B", 0, 1000)).toEqual([
      { actorId: "B", origin: "https://c.test", reason: "no grant", at: 150 },
    ]);
  });

  it("drops a refusal older than the TTL", () => {
    recordRefusal("A", "https://old.test", "no grant", 0);
    const now = 30 * 60 * 1000 + 1;
    expect(drainRefusals("A", 0, now)).toEqual([]);
  });

  it("since excludes earlier entries", () => {
    recordRefusal("A", "https://early.test", "no grant", 100);
    recordRefusal("A", "https://late.test", "no grant", 500);
    expect(drainRefusals("A", 300, 1000)).toEqual([
      { actorId: "A", origin: "https://late.test", reason: "no grant", at: 500 },
    ]);
    // The earlier entry is still pending (since excluded it, not TTL).
    expect(drainRefusals("A", 0, 1000)).toEqual([
      { actorId: "A", origin: "https://early.test", reason: "no grant", at: 100 },
    ]);
  });
});
