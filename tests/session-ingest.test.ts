import { expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ingestSessions, ingestSessionsSerialized } from "../src/ingest/sessions/ingest.js";
import { searchKnowledge, upsertSourceDocsBatched } from "../src/services/knowledge.js";
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
  await vi.waitFor(() => expect(calls).toBe(1));
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

test("batching: 64 unique one-chunk docs produce 2 embed calls of 32 each", async () => {
  const { db } = await import("../src/db/client.js");
  const { embeddings } = await import("../src/db/schema.js");
  const { inArray } = await import("drizzle-orm");

  const embedCallLengths: number[] = [];
  const countingEmb: FakeEmbedder = Object.assign(Object.create(FakeEmbedder.prototype), {
    ...new FakeEmbedder(1024),
    async embed(texts: string[]) {
      embedCallLengths.push(texts.length);
      return FakeEmbedder.prototype.embed.call(this, texts);
    },
  });

  const runId = `${Date.now()}-${randomUUID()}`;
  const docs = Array.from({ length: 64 }, (_, i) => ({
    ref: `batch-${runId}-${i}`,
    text: `chunk ${runId} ${i}`,
    hash: `h-${runId}-${i}`,
  }));
  const src: SessionSource = { source: "batch", listSessionDocs: async () => docs };

  await ingestSessions([src], countingEmb, 30);

  expect(embedCallLengths).toEqual([32, 32]);
  const rows = await db.select({ id: embeddings.id }).from(embeddings).where(inArray(embeddings.sourceRef, docs.map((d) => d.ref)));
  expect(rows.length).toBe(64);
});

test("upsertSourceDocsBatched: mid-batch write failure isolates error and subsequent docs keep their vectors", async () => {
  const { db } = await import("../src/db/client.js");
  const { embeddings } = await import("../src/db/schema.js");
  const { eq, sql: dsql } = await import("drizzle-orm");

  const runId = `midfail-${Date.now()}-${randomUUID()}`;
  const doc0 = { ref: `ref0-${runId}`, text: `unique content zero ${runId}` };
  const doc1 = { ref: `ref1-${runId}`, text: `unique content one ${runId}`, projectId: "invalid-uuid" };
  const doc2 = { ref: `ref2-${runId}`, text: `unique content two ${runId}` };

  const results = await upsertSourceDocsBatched("session", [doc0, doc1, doc2], emb, 10);

  expect(results.length).toBe(3);
  expect(results[0]).toEqual({ ref: doc0.ref, ok: true });
  expect(results[1].ref).toBe(doc1.ref);
  expect(results[1].ok).toBe(false);
  expect(results[1].error).toBeDefined();
  expect(results[2]).toEqual({ ref: doc2.ref, ok: true });

  // doc1 failed to write: no rows in DB
  const rows1 = await db.select().from(embeddings).where(eq(embeddings.sourceRef, doc1.ref));
  expect(rows1.length).toBe(0);

  // doc2 succeeded and preserved its own vector (not doc1's vector)
  const rows2 = await db.select({
    content: embeddings.content,
    embedding: dsql<string>`${embeddings.embedding}::text`,
  }).from(embeddings).where(eq(embeddings.sourceRef, doc2.ref));
  expect(rows2.length).toBe(1);

  const raw = rows2[0].embedding.trim();
  const savedVec: number[] = JSON.parse(raw.startsWith("[") ? raw : `[${raw}]`);
  const [expectedVec2] = await emb.embed([doc2.text]);
  const [wrongVec1] = await emb.embed([doc1.text]);

  expect(savedVec.length).toBe(1024);
  for (let i = 0; i < 10; i++) {
    expect(savedVec[i]).toBeCloseTo(expectedVec2[i], 3);
  }
  // Verify it did not receive doc1's vector
  const diffFromWrong = Math.abs(savedVec[0] - wrongVec1[0]);
  expect(diffFromWrong).toBeGreaterThan(0.001);
});


test("per-source progress reports listing, checking and embedding with done/total counts", async () => {
  const uniq = `prog-${Date.now()}-${Math.round(performance.now() * 1000)}`;
  const docsA = [
    { ref: `a1#${uniq}`, text: `text a1 ${uniq}`, hash: `ha1-${uniq}` },
    { ref: `a2#${uniq}`, text: `text a2 ${uniq}`, hash: `ha2-${uniq}` },
  ];
  const docsB = [
    { ref: `b1#${uniq}`, text: `text b1 ${uniq}`, hash: `hb1-${uniq}` },
    { ref: `b2#${uniq}`, text: `text b2 ${uniq}`, hash: `hb2-${uniq}` },
    { ref: `b3#${uniq}`, text: `text b3 ${uniq}`, hash: `hb3-${uniq}` },
  ];
  const srcA: SessionSource = { source: "a", listSessionDocs: async () => docsA };
  const srcB: SessionSource = { source: "b", listSessionDocs: async () => docsB };

  const log: any[] = [];
  const s: any = {};
  const ctx = {
    cancelled: false,
    progress(p: any) {
      Object.assign(s, p);
      log.push({ ...s });
    },
  };

  await ingestSessions([srcA, srcB], emb, 30, ctx);

  expect(log.some((entry) => entry.phase === "a (1/2): checking")).toBe(true);
  expect(log.some((entry) => entry.phase === "a (1/2): embedding")).toBe(true);
  expect(log.some((entry) => entry.phase === "b (2/2): embedding")).toBe(true);
  expect(log.some((entry) => entry.phase === "a (1/2): embedding" && entry.done === 2 && entry.total === 2)).toBe(true);
  expect(log[log.length - 1].done).toBe(3);
  expect(log[log.length - 1].total).toBe(3);
});

test("cancel between docs stops before completing all sources", async () => {
  const uniq = `cancel-${Date.now()}-${Math.round(performance.now() * 1000)}`;
  const docSkipped = { ref: `c0#${uniq}`, text: `text c0 ${uniq}`, hash: `hc0-${uniq}` };
  await ingestSessions([{ source: "a", listSessionDocs: async () => [docSkipped] }], emb, 30);

  const docsA = [
    docSkipped,
    { ref: `c1#${uniq}`, text: `text c1 ${uniq}`, hash: `hc1-${uniq}` },
    { ref: `c2#${uniq}`, text: `text c2 ${uniq}`, hash: `hc2-${uniq}` },
  ];
  let bCalls = 0;
  const srcA: SessionSource = { source: "a", listSessionDocs: async () => docsA };
  const srcB: SessionSource = { source: "b", listSessionDocs: async () => { bCalls++; return []; } };

  let cancelFlag = false;
  const ctx = {
    get cancelled() { return cancelFlag; },
    progress(p: any) {
      if (typeof p.done === "number" && p.done >= 1) {
        cancelFlag = true;
      }
    },
  };

  const r = await ingestSessions([srcA, srcB], emb, 30, ctx);

  expect(r.a.indexed).toBeLessThan(2);
  expect(bCalls).toBe(0);
  expect(r.b).toBeUndefined();
});
