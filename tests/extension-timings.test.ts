import { describe, it, expect, vi } from "vitest";
import { createPhaseTimer } from "../extension/timings.js";

const fakeClock = (...ticks: number[]) => {
  const q = [...ticks];
  return vi.fn(() => q.shift() as number);
};

describe("createPhaseTimer", () => {
  it("sums repeated phases per name", async () => {
    const t = createPhaseTimer(true, fakeClock(0, 5, 10, 17, 20, 24));
    await t.time("a", async () => 1);
    await t.time("a", async () => 2);
    await t.time("b", async () => 3);
    expect(t.result()).toEqual({ a: 12, b: 4 });
  });

  it("rounds to 0.1 and add accumulates", () => {
    const t = createPhaseTimer(true, vi.fn());
    t.add("x", 1.04);
    t.add("x", 1.04);
    t.add("y", 0.26);
    expect(t.result()).toEqual({ x: 2.1, y: 0.3 });
  });

  it("records a rejecting phase and rethrows", async () => {
    const t = createPhaseTimer(true, fakeClock(0, 7));
    await expect(t.time("bad", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(t.result()).toEqual({ bad: 7 });
  });

  it("off: passthrough, no clock, no result", async () => {
    const clock = vi.fn();
    const t = createPhaseTimer(false, clock);
    expect(await t.time("a", async () => 42)).toBe(42);
    t.add("a", 5);
    expect(t.result()).toBeUndefined();
    expect(clock).not.toHaveBeenCalled();
  });
});
