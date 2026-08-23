import { afterAll, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { fetchCatalog, CATALOG_CACHE } from "../src/chat/catalog.js";

let hits = 0;
let payload: unknown = {
  data: [
    { id: "deepseek/deepseek-chat", supported_parameters: ["tools"], architecture: { input_modalities: ["text"] } },
    { id: "qwen/qwen-2.5", supported_parameters: [], architecture: { input_modalities: ["text", "image"] } },
  ],
};
const server: Server = createServer((_req, res) => {
  hits++;
  res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
  res.end(JSON.stringify(payload));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
afterAll(() => server.close());

test("fetches model ids with tool/vision flags and caches per baseUrl", async () => {
  CATALOG_CACHE.clear();
  const first = await fetchCatalog(BASE, "k");
  expect(first).toEqual([
    { id: "deepseek/deepseek-chat", tools: true, vision: false },
    { id: "qwen/qwen-2.5", tools: false, vision: true },
  ]);
  const again = await fetchCatalog(BASE, "k");
  expect(again).toEqual(first);
  expect(hits).toBe(1); // second call served from cache
});

test("a failed fetch returns [] and does not poison the cache", async () => {
  CATALOG_CACHE.clear();
  const bad = await fetchCatalog("http://127.0.0.1:1/v1", "k");
  expect(bad).toEqual([]);
  expect(CATALOG_CACHE.size).toBe(0); // next call retries instead of caching the failure
});
