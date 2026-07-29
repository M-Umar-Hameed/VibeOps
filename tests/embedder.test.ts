import { afterEach, expect, test, vi } from "vitest";
import { FakeEmbedder, VoyageEmbedder, getEmbedder } from "../src/knowledge/embedder.js";

test("FakeEmbedder is deterministic and correctly sized", async () => {
  const e = new FakeEmbedder(1024);
  const [a] = await e.embed(["hello"]);
  const [b] = await e.embed(["hello"]);
  expect(a).toHaveLength(1024);
  expect(a).toEqual(b);
  const [c] = await e.embed(["different"]);
  expect(c).not.toEqual(a);
});

test("getEmbedder returns fake when EMBED_PROVIDER=fake", () => {
  process.env.EMBED_PROVIDER = "fake";
  const e = getEmbedder();
  expect(e.dim).toBe(1024);
});

test("unknown model throws", () => {
  const saved = { EMBED_PROVIDER: process.env.EMBED_PROVIDER, EMBED_MODEL: process.env.EMBED_MODEL };
  try {
    process.env.EMBED_PROVIDER = "voyage";
    process.env.EMBED_MODEL = "not-a-real-model";
    expect(() => getEmbedder()).toThrow();
  } finally {
    if (saved.EMBED_PROVIDER === undefined) delete process.env.EMBED_PROVIDER; else process.env.EMBED_PROVIDER = saved.EMBED_PROVIDER;
    if (saved.EMBED_MODEL === undefined) delete process.env.EMBED_MODEL; else process.env.EMBED_MODEL = saved.EMBED_MODEL;
  }
});

afterEach(() => vi.unstubAllGlobals());

const NEW_MODELS = ["voyage-4-large", "voyage-4", "voyage-4-lite", "voyage-3-large", "voyage-law-2", "voyage-finance-2"];
const MATRYOSHKA = new Set(["voyage-4-large", "voyage-4", "voyage-4-lite", "voyage-3-large"]);

test.each(NEW_MODELS)("%s: dim 1024, output_dimension only for matryoshka", async (model) => {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0) }] }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const e = new VoyageEmbedder(model, "k");
  expect(e.dim).toBe(1024);
  await e.embed(["x"]);
  const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
  expect(body.model).toBe(model);
  if (MATRYOSHKA.has(model)) expect(body.output_dimension).toBe(1024);
  else expect(body.output_dimension).toBeUndefined();
});
