import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { armExport, configureExport } from "../src/services/export-debounce.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  configureExport(null); // disarm + clear any pending timer
  vi.useRealTimers();
});

test("a write then quiet produces one export within the debounce window", async () => {
  const exp = vi.fn(async () => {});
  configureExport(exp, { debounceMs: 100, floorMs: 500 });
  armExport();
  expect(exp).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(exp).toHaveBeenCalledTimes(1);
});

test("a burst of writes produces exactly one export", async () => {
  const exp = vi.fn(async () => {});
  configureExport(exp, { debounceMs: 100, floorMs: 500 });
  for (let i = 0; i < 20; i++) {
    armExport();
    await vi.advanceTimersByTimeAsync(10); // each write within the debounce gap
  }
  expect(exp).not.toHaveBeenCalled(); // timer kept resetting during the burst
  await vi.advanceTimersByTimeAsync(100); // quiet
  expect(exp).toHaveBeenCalledTimes(1);
});

test("floor spaces write-triggered exports apart (no storm)", async () => {
  const exp = vi.fn(async () => {});
  configureExport(exp, { debounceMs: 100, floorMs: 500 });
  armExport();
  await vi.advanceTimersByTimeAsync(100); // t=100: first export
  expect(exp).toHaveBeenCalledTimes(1);
  armExport();                             // t=100: arms -> t=200
  await vi.advanceTimersByTimeAsync(100);  // t=200: debounce done, floor defers to t=600
  expect(exp).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(400);  // t=600: floor boundary reached
  expect(exp).toHaveBeenCalledTimes(2);
});

test("no export function configured: arming is a no-op", () => {
  configureExport(null);
  armExport();
  expect(vi.getTimerCount()).toBe(0);
});
