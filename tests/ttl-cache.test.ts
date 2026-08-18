import { expect, test } from "vitest";
import { ttlCache } from "../src/services/ttl-cache.js";

test("memoizes a resolved value within the TTL", async () => {
  const cache = ttlCache<number>(10_000);
  let calls = 0;
  const load = async () => { calls++; return 42; };
  expect(await cache.get("k", load)).toBe(42);
  expect(await cache.get("k", load)).toBe(42);
  expect(calls).toBe(1);
});

test("a rejected loader is never cached", async () => {
  const cache = ttlCache<number>(10_000);
  await expect(cache.get("k", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  expect(await cache.get("k", async () => 7)).toBe(7);
});

test("invalidate(key) forces a reload; invalidate() clears all", async () => {
  const cache = ttlCache<number>(10_000);
  let n = 0;
  const load = async () => ++n;
  expect(await cache.get("a", load)).toBe(1);
  cache.invalidate("a");
  expect(await cache.get("a", load)).toBe(2);
  expect(await cache.get("b", load)).toBe(3);
  cache.invalidate();
  expect(await cache.get("a", load)).toBe(4);
});
