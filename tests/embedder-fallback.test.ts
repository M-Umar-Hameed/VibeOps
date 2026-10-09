import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  FakeEmbedder, LocalEmbedder, VoyageEmbedder, VoyageWithLocalFallback,
  getEmbedder, resetVoyageFallback, resetVoyageThrottle,
} from "../src/knowledge/embedder.js";

beforeEach(() => { resetVoyageFallback(); resetVoyageThrottle(); process.env.VOYAGE_MIN_INTERVAL_MS = "0"; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); delete process.env.VOYAGE_MIN_INTERVAL_MS; });

test("voyage failure -> local fallback, local-tagged, sticky, single warn", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })));

  const primary = new VoyageEmbedder("voyage-3", "k");   // model voyage-3, dim 1024
  const local = new FakeEmbedder(384);                    // stands in for LocalEmbedder
  const localEmbed = vi.spyOn(local, "embed");
  const w = new VoyageWithLocalFallback(primary, () => local);

  const [v1] = await w.embed(["doc a"]);
  expect(v1).toHaveLength(384);          // local vector, not voyage 1024
  expect(w.model).toBe("fake");          // local tag, NEVER voyage
  expect(w.dim).toBe(384);
  expect(localEmbed).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledTimes(2);

  (fetch as any).mockClear();
  await w.embed(["doc b"]);              // subsequent call skips voyage
  expect(fetch).not.toHaveBeenCalled();
  expect(localEmbed).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledTimes(2); // no per-doc spam
});

test("getEmbedder returns LocalEmbedder directly once fallback is sticky", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // Trip the sticky flag via a wrapper failure.
  await new VoyageWithLocalFallback(new VoyageEmbedder("voyage-3", "k"), () => new FakeEmbedder(384)).embed(["x"]);

  const saved = { p: process.env.EMBED_PROVIDER, k: process.env.VOYAGE_API_KEY };
  delete process.env.EMBED_PROVIDER; process.env.VOYAGE_API_KEY = "k";
  try {
    expect(getEmbedder()).toBeInstanceOf(LocalEmbedder);  // not the wrapper
  } finally {
    if (saved.p === undefined) delete process.env.EMBED_PROVIDER; else process.env.EMBED_PROVIDER = saved.p;
    if (saved.k === undefined) delete process.env.VOYAGE_API_KEY; else process.env.VOYAGE_API_KEY = saved.k;
  }
});

test("re-probes voyage after the cooldown window expires", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // Cooldown 0: the failure sets voyageFallbackUntil = now + 0, so the very next
  // call is already past the window and must re-probe the primary.
  process.env.VIBEOPS_VOYAGE_COOLDOWN_MS = "0";
  resetVoyageFallback();
  try {
    let calls = 0;
    const primary = new FakeEmbedder(1024);
    vi.spyOn(primary, "embed").mockImplementation(async (texts: string[]) => {
      calls++;
      if (calls === 1) throw new Error("voyage embed failed: 503");
      return texts.map(() => new Array(1024).fill(0.1));
    });
    const local = new FakeEmbedder(384);
    const localEmbed = vi.spyOn(local, "embed");
    const w = new VoyageWithLocalFallback(primary, () => local);

    const [a] = await w.embed(["first"]);   // primary throws -> local
    expect(a).toHaveLength(384);
    expect(localEmbed).toHaveBeenCalledTimes(1);

    const [b] = await w.embed(["second"]);  // window already expired -> primary retried
    expect(b).toHaveLength(1024);           // voyage vector, recovered
    expect(calls).toBe(2);                  // primary was probed again
    expect(localEmbed).toHaveBeenCalledTimes(1); // local not used the second time
  } finally {
    delete process.env.VIBEOPS_VOYAGE_COOLDOWN_MS;
    resetVoyageFallback();
  }
});

test("does NOT re-probe voyage while still inside the cooldown window", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env.VIBEOPS_VOYAGE_COOLDOWN_MS = "600000"; // 10 min: far longer than the test
  resetVoyageFallback();
  try {
    const primary = new FakeEmbedder(1024);
    const primaryEmbed = vi.spyOn(primary, "embed").mockImplementation(async () => { throw new Error("voyage embed failed: 503"); });
    const local = new FakeEmbedder(384);
    const w = new VoyageWithLocalFallback(primary, () => local);

    await w.embed(["first"]);               // trips cooldown
    expect(primaryEmbed).toHaveBeenCalledTimes(1);
    await w.embed(["second"]);              // inside window -> no re-probe
    expect(primaryEmbed).toHaveBeenCalledTimes(1);
  } finally {
    delete process.env.VIBEOPS_VOYAGE_COOLDOWN_MS;
    resetVoyageFallback();
  }
});
