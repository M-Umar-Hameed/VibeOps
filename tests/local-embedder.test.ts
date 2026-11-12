import { describe, expect, it } from "vitest";
import { FakeEmbedder, LocalEmbedder, getEmbedder, padTo } from "../src/knowledge/embedder.js";

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe("padTo", () => {
  it("pads with trailing zeros to the target width", () => {
    expect(padTo([1, 2], 5)).toEqual([1, 2, 0, 0, 0]);
    expect(padTo([1, 2, 3], 3)).toEqual([1, 2, 3]);
  });

  it("preserves cosine similarity", () => {
    const a = [0.1, -0.4, 0.8], b = [0.3, 0.2, -0.5];
    expect(cosine(padTo(a, 10), padTo(b, 10))).toBeCloseTo(cosine(a, b), 12);
  });
});

describe("getEmbedder default chain", () => {
  const saved = { EMBED_PROVIDER: process.env.EMBED_PROVIDER, VOYAGE_API_KEY: process.env.VOYAGE_API_KEY, EMBED_MODEL: process.env.EMBED_MODEL };
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };

  it("defaults to local with no env at all", () => {
    delete process.env.EMBED_PROVIDER; delete process.env.VOYAGE_API_KEY; delete process.env.EMBED_MODEL;
    try { expect(getEmbedder()).toBeInstanceOf(LocalEmbedder); } finally { restore(); }
  });

  it("prefers voyage when only a key is set", () => {
    delete process.env.EMBED_PROVIDER; delete process.env.EMBED_MODEL; process.env.VOYAGE_API_KEY = "k";
    try { expect(getEmbedder().model).toBe("voyage-3"); } finally { restore(); }
  });

  it("explicit provider wins over the key", () => {
    process.env.EMBED_PROVIDER = "fake"; delete process.env.EMBED_MODEL; process.env.VOYAGE_API_KEY = "k";
    try { expect(getEmbedder()).toBeInstanceOf(FakeEmbedder); } finally { restore(); }
  });

  it("uses EMBED_MODEL with local provider", () => {
    process.env.EMBED_PROVIDER = "local"; process.env.EMBED_MODEL = "nomic-embed-text-v1.5";
    try {
      const e = getEmbedder();
      expect(e).toBeInstanceOf(LocalEmbedder);
      expect(e.model).toBe("nomic-embed-text-v1.5");
      expect(e.dim).toBe(768);
    } finally { restore(); }
  });
});

// Real model download + inference — excluded from the default (offline) suite.
describe.skipIf(!process.env.LOCAL_EMBED_TEST)("LocalEmbedder (live, LOCAL_EMBED_TEST=1)", () => {
  it("embeds to 1024-wide padded vectors with true dim 384", async () => {
    const e = new LocalEmbedder();
    const [a, b] = await e.embed(["postgres backup strategy", "postgres backup strategy"]);
    expect(e.dim).toBe(384);
    expect(a).toHaveLength(1024);
    expect(a.slice(384).every((x) => x === 0)).toBe(true);
    expect(cosine(a, b)).toBeCloseTo(1, 5);
  }, 120_000);
});
