import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  FakeEmbedder, LocalEmbedder, VoyageEmbedder, VoyageWithLocalFallback,
  getEmbedder, resetVoyageFallback,
} from "../src/knowledge/embedder.js";

beforeEach(() => resetVoyageFallback());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("voyage failure -> local fallback, local-tagged, sticky, single warn", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));

  const primary = new VoyageEmbedder("voyage-3", "k");   // model voyage-3, dim 1024
  const local = new FakeEmbedder(384);                    // stands in for LocalEmbedder
  const localEmbed = vi.spyOn(local, "embed");
  const w = new VoyageWithLocalFallback(primary, () => local);

  const [v1] = await w.embed(["doc a"]);
  expect(v1).toHaveLength(384);          // local vector, not voyage 1024
  expect(w.model).toBe("fake");          // local tag, NEVER voyage
  expect(w.dim).toBe(384);
  expect(localEmbed).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledTimes(1);

  (fetch as any).mockClear();
  await w.embed(["doc b"]);              // subsequent call skips voyage
  expect(fetch).not.toHaveBeenCalled();
  expect(localEmbed).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledTimes(1); // no per-doc spam
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
