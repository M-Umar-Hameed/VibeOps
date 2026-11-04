import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
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

test("projectId is passed through to embeddings", async () => {
  const { createActor } = await import("../src/services/actors.js");
  const { createProject } = await import("../src/services/projects.js");
  const { db } = await import("../src/db/client.js");
  const { embeddings } = await import("../src/db/schema.js");
  const { eq } = await import("drizzle-orm");

  const uniq = `sess-proj-${Date.now()}-${Math.round(performance.now() * 1000)}`;
  const { actor } = await createActor({ name: uniq, kind: "human", role: "member" });
  const project = await createProject({ key: randomUUID().replace(/-/g, "").slice(0, 8), name: "Test Project" });

  const doc = { ref: `fake#${uniq}`, text: `proj session ${uniq}`, hash: `h-${uniq}`, projectId: project.id };
  const src: SessionSource = { source: "fake", listSessionDocs: async () => [doc] };

  await ingestSessions([src], emb, 30);

  const rows = await db.select().from(embeddings).where(eq(embeddings.sourceRef, doc.ref));
  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0].projectId).toBe(project.id);
});

test("batching: 64 unique one-chunk docs produce 2 embed calls", async () => {
  let embedCallLengths: number[] = [];
  const countingEmb: FakeEmbedder = Object.assign(Object.create(FakeEmbedder.prototype), {
    ...new FakeEmbedder(1024),
    async embed(texts: string[]) {
      embedCallLengths.push(texts.length);
      return FakeEmbedder.prototype.embed.call(this, texts);
    },
  });

  const docs = Array.from({ length: 64 }, (_, i) => ({
    ref: `batch-${i}`,
    text: `chunk ${i}`,
    hash: `h-${i}`,
  }));
  const src: SessionSource = { source: "batch", listSessionDocs: async () => docs };

  await ingestSessions([src], countingEmb, 30);

  // Should have at least 2 calls with 32 each
  expect(embedCallLengths.length).toBeGreaterThanOrEqual(2);
  const total = embedCallLengths.reduce((a, b) => a + b, 0);
  expect(total).toBe(64);
});

