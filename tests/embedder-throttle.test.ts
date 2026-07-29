import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  FakeEmbedder, VoyageEmbedder, VoyageWithLocalFallback,
  resetVoyageFallback, resetVoyageThrottle,
} from "../src/knowledge/embedder.js";

const ok = () => new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), { status: 200 });
const tooMany = (retryAfter?: string) =>
  new Response("rate limited", { status: 429, headers: retryAfter === undefined ? {} : { "retry-after": retryAfter } });

beforeEach(() => {
  resetVoyageFallback();
  resetVoyageThrottle();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.VOYAGE_MIN_INTERVAL_MS;
});

test("no artificial delay before any 429", async () => {
  const starts: number[] = [];
  vi.stubGlobal("fetch", vi.fn(async () => { starts.push(Date.now()); return ok(); }));
  const e = new VoyageEmbedder("voyage-3", "k");
  await e.embed(["a"]);
  await e.embed(["b"]);
  expect(starts[1] - starts[0]).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test("after a 429, default backoff then 21s interval govern request starts", async () => {
  const starts: number[] = [];
  vi.stubGlobal("fetch", vi.fn(async () => {
    starts.push(Date.now());
    return starts.length === 1 ? tooMany() : ok();   // no Retry-After -> default 30s
  }));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const e = new VoyageEmbedder("voyage-3", "k");
  const p1 = e.embed(["a"]);
  await vi.advanceTimersByTimeAsync(30_000);
  await p1;
  const p2 = e.embed(["b"]);
  await vi.advanceTimersByTimeAsync(21_000);
  await p2;
  expect(starts[1] - starts[0]).toBe(30_000);  // default backoff, no header
  expect(starts[2] - starts[1]).toBe(21_000);  // adaptive interval after first 429
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith("voyage 429, retrying with backoff");
});

test("429 then 200 returns vectors, sticky flag stays unflipped", async () => {
  let n = 0;
  vi.stubGlobal("fetch", vi.fn(async () => (++n === 1 ? tooMany("0") : ok())));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const local = new FakeEmbedder(384);
  const localEmbed = vi.spyOn(local, "embed");
  const w = new VoyageWithLocalFallback(new VoyageEmbedder("voyage-3", "k"), () => local);
  const p = w.embed(["a"]);
  await vi.advanceTimersByTimeAsync(21_000);   // retry-after 0, then 21s interval wait
  const [v] = await p;
  expect(v).toHaveLength(1024);                // voyage vector (padTo 1024)
  expect(w.model).toBe("voyage-3");            // flag never flipped
  expect(localEmbed).not.toHaveBeenCalled();
});

test("429 x4 exhausts retries, falls back local, flag sticky", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => tooMany("0")));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const local = new FakeEmbedder(384);
  const w = new VoyageWithLocalFallback(new VoyageEmbedder("voyage-3", "k"), () => local);
  const p = w.embed(["a"]);
  await vi.advanceTimersByTimeAsync(63_000);   // 3 x 21s interval waits (retry-after 0)
  const [v] = await p;
  expect(v).toHaveLength(384);
  expect(w.model).toBe("fake");
  expect(fetch).toHaveBeenCalledTimes(4);      // initial + 3 retries
  expect(warn.mock.calls.map(([m]) => String(m))).toEqual([
    "voyage 429, retrying with backoff",
    "voyage embed failed: 429, falling back to local embedder",
  ]);
  (fetch as any).mockClear();
  await w.embed(["b"]);
  expect(fetch).not.toHaveBeenCalled();        // sticky
});

test("Retry-After header honored over default backoff", async () => {
  process.env.VOYAGE_MIN_INTERVAL_MS = "0";    // isolate backoff from interval
  const starts: number[] = [];
  vi.stubGlobal("fetch", vi.fn(async () => {
    starts.push(Date.now());
    return starts.length === 1 ? tooMany("7") : ok();
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const p = new VoyageEmbedder("voyage-3", "k").embed(["a"]);
  await vi.advanceTimersByTimeAsync(7_000);
  await p;
  expect(starts[1] - starts[0]).toBe(7_000);   // 7s from header, not 30s default
});

test("20 consecutive successes halve the throttled interval", async () => {
  const starts: number[] = [];
  let n = 0;
  vi.stubGlobal("fetch", vi.fn(async () => { starts.push(Date.now()); return ++n === 1 ? tooMany("0") : ok(); }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const e = new VoyageEmbedder("voyage-3", "k");
  const p1 = e.embed(["a"]);
  await vi.advanceTimersByTimeAsync(21_000);
  await p1;                                    // success #1
  for (let i = 0; i < 19; i++) {               // successes #2..#20 -> halve to 10500
    const p = e.embed(["x"]);
    await vi.advanceTimersByTimeAsync(21_000);
    await p;
  }
  const p = e.embed(["y"]);
  await vi.advanceTimersByTimeAsync(10_500);
  await p;
  const last = starts.length - 1;
  expect(starts[last] - starts[last - 1]).toBe(10_500);
});
