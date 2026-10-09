import { afterEach, expect, test, vi } from "vitest";
import { HttpEmbedder, getEmbedder } from "../src/knowledge/embedder.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mockEmbeddings(dims: number[][], ok = true, status = 200) {
  const fetchMock = vi.fn(async () => ({
    ok, status,
    json: async () => ({ data: dims.map((embedding) => ({ embedding })) }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

test("posts OpenAI-shaped body to <base>/v1/embeddings and pads to 1024", async () => {
  const fetchMock = mockEmbeddings([new Array(256).fill(0.5), new Array(256).fill(0.25)]);
  const e = new HttpEmbedder("model2vec", 256, "http://127.0.0.1:8081");
  const out = await e.embed(["a", "b"]);

  expect(out).toHaveLength(2);
  expect(out[0]).toHaveLength(1024);                 // padded from 256
  expect(out[0].slice(0, 256).every((x) => x === 0.5)).toBe(true);
  expect(out[0].slice(256).every((x) => x === 0)).toBe(true); // zero padding

  const [url, init] = fetchMock.mock.calls[0] as [string, any];
  expect(url).toBe("http://127.0.0.1:8081/v1/embeddings");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body)).toEqual({ model: "model2vec", input: ["a", "b"] });
});

test("strips a trailing slash on the base url", async () => {
  const fetchMock = mockEmbeddings([new Array(256).fill(1)]);
  await new HttpEmbedder("m", 256, "http://127.0.0.1:8081/").embed(["x"]);
  expect((fetchMock.mock.calls[0] as any)[0]).toBe("http://127.0.0.1:8081/v1/embeddings");
});

test("sends a bearer header only when an api key is set", async () => {
  const withKey = mockEmbeddings([new Array(256).fill(1)]);
  await new HttpEmbedder("m", 256, "http://h", "secret").embed(["x"]);
  expect((withKey.mock.calls[0] as any)[1].headers.authorization).toBe("Bearer secret");

  const noKey = mockEmbeddings([new Array(256).fill(1)]);
  await new HttpEmbedder("m", 256, "http://h").embed(["x"]);
  expect((noKey.mock.calls[0] as any)[1].headers.authorization).toBeUndefined();
});

test("throws on a non-ok response", async () => {
  mockEmbeddings([], false, 503);
  await expect(new HttpEmbedder("m", 256, "http://h").embed(["x"])).rejects.toThrow(/http embed failed: 503/);
});

test("throws when the row count does not match the input count", async () => {
  mockEmbeddings([new Array(256).fill(1)]); // 1 row
  await expect(new HttpEmbedder("m", 256, "http://h").embed(["a", "b"])).rejects.toThrow(/returned 1 rows for 2 inputs/);
});

test("constructing without a base url fails fast", () => {
  expect(() => new HttpEmbedder("m", 256, "")).toThrow(/requires a base url/);
});

test("getEmbedder returns an HttpEmbedder for EMBED_PROVIDER=model2vec", () => {
  const saved = { p: process.env.EMBED_PROVIDER, u: process.env.EMBED_HTTP_URL, d: process.env.EMBED_DIM };
  process.env.EMBED_PROVIDER = "model2vec";
  process.env.EMBED_HTTP_URL = "http://127.0.0.1:8081";
  process.env.EMBED_DIM = "256";
  try {
    const e = getEmbedder();
    expect(e).toBeInstanceOf(HttpEmbedder);
    expect(e.dim).toBe(256);
  } finally {
    for (const [k, v] of [["EMBED_PROVIDER", saved.p], ["EMBED_HTTP_URL", saved.u], ["EMBED_DIM", saved.d]] as const) {
      if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v;
    }
  }
});
