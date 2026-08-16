import { expect, test } from "vitest";
import { ingestSessions, ingestSessionsSerialized } from "../src/ingest/sessions/ingest.js";
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

  const hits = await searchKnowledge(doc.text, { limit: 20 }, emb);
  expect(hits.some((h) => h.sourceRef === doc.ref && h.sourceKind === "session")).toBe(true);
});

test("serialized ingest skips when one is already running (no double-ingest)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let calls = 0;
  const slow: SessionSource = { source: "slow", listSessionDocs: async () => { calls++; await gate; return []; } };
  const a = ingestSessionsSerialized([slow], emb, 1);
  await Promise.resolve();
  const b = await ingestSessionsSerialized([slow], emb, 1);
  expect(b).toBeNull();
  expect(calls).toBe(1);
  release();
  await a;
});

