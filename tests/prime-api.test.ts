import { expect, test, vi } from "vitest";
import { createActor } from "../src/services/actors.js";
import { getEmbedder } from "../src/knowledge/embedder.js";
import * as knowledgeService from "../src/services/knowledge.js";
import { app } from "../src/api/app.js";

process.env.EMBED_PROVIDER = "fake";
const { upsertVaultFile } = knowledgeService;

test("REST: /prime returns a primer for a matching query", async () => {
  const { apiKey } = await createActor({ name: "primer", kind: "human" });
  const h = { Authorization: `Bearer ${apiKey}` };

  // FakeEmbedder has no semantic ranking, so query with the exact seeded text
  // for a guaranteed distance-0 top hit (same approach as knowledge-api.test.ts).
  const uniq = `run-${Date.now()}-${Math.round(performance.now() * 1000)}`;
  const content = `deploy runbook lives in confluence ${uniq}`;
  await upsertVaultFile(`/fake/vault/${uniq}.md`, content, getEmbedder());

  // Retry once: hnsw recall for a just-inserted row is transiently unreliable
  // under concurrent test-file writes (same caveat as knowledge-api.test.ts).
  const check = async () => {
    const res = await app.request(`/prime?q=${encodeURIComponent(content)}&limit=20`, { headers: h });
    expect(res.status).toBe(200);
    const text = await res.text();
    return text.includes(`VibeOps primer for "${content}"`) && text.includes(uniq) ? text : undefined;
  };
  let text = await check();
  if (!text) {
    await new Promise((r) => setTimeout(r, 750));
    text = await check();
  }
  expect(text).toBeDefined();
});

test("REST: /prime returns the no-knowledge line when nothing matches", async () => {
  const { apiKey } = await createActor({ name: "primer-miss", kind: "human" });
  const h = { Authorization: `Bearer ${apiKey}` };

  // searchKnowledge always returns its top-k over a populated shared table, so
  // there's no query text that reliably yields zero hits; stub it directly to
  // exercise the empty-result formatting branch.
  const spy = vi.spyOn(knowledgeService, "searchKnowledge").mockResolvedValueOnce([]);
  try {
    const res = await app.request("/prime?q=anything", { headers: h });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe(`VibeOps primer: no relevant knowledge for "anything".`);
  } finally {
    spy.mockRestore();
  }
});

test("REST: /prime response stays under 4000 chars with many long docs", async () => {
  const { apiKey } = await createActor({ name: "primer-cap", kind: "human" });
  const h = { Authorization: `Bearer ${apiKey}` };

  const uniq = `cap-${Date.now()}-${Math.round(performance.now() * 1000)}`;
  const embedder = getEmbedder();
  for (let i = 0; i < 5; i++) {
    const content = `${uniq} doc ${i} `.repeat(50); // ~1000 chars each
    await upsertVaultFile(`/fake/vault/${uniq}-${i}.md`, content, embedder);
  }

  const res = await app.request(`/prime?q=${encodeURIComponent(uniq)}&limit=10`, { headers: h });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text.length).toBeLessThanOrEqual(4000);
});

test("REST: /prime requires auth", async () => {
  const res = await app.request("/prime?q=anything");
  expect(res.status).toBe(401);
});
