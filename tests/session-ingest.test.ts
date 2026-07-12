import { expect, test } from "vitest";
import { ingestSessions } from "../src/ingest/sessions/cli.js";
import { searchKnowledge } from "../src/services/knowledge.js";
import { FakeEmbedder } from "../src/knowledge/embedder.js";
import type { SessionSource } from "../src/ingest/sessions/source.js";

const emb = new FakeEmbedder(1024);

test("ingest is hash-gated and retrievable; failures isolated", async () => {
  const uniq = `sess-${Date.now()}-${Math.round(performance.now() * 1000)}`;
  const doc = { ref: `fake#${uniq}`, text: `decided to use pglite ${uniq}`, hash: `h-${uniq}` };
  const good: SessionSource = { source: "fake", listSessionDocs: async () => [doc] };
  const bad: SessionSource = { source: "boom", listSessionDocs: async () => { throw new Error("down"); } };

  const r1 = await ingestSessions([good, bad], emb, 30);
  expect(r1.fake.indexed).toBe(1);
  expect(r1.boom.failed).toBe(1);

  const r2 = await ingestSessions([good], emb, 30); // unchanged hash -> skipped
  expect(r2.fake.skipped).toBe(1);
  expect(r2.fake.indexed).toBe(0);

  const hits = await searchKnowledge(doc.text, { limit: 5 }, emb);
  expect(hits.some((h) => h.sourceRef === doc.ref && h.sourceKind === "session")).toBe(true);
});
