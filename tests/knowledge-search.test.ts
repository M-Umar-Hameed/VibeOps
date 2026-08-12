import { expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { FakeEmbedder } from "../src/knowledge/embedder.js";
import { upsertVaultFile, searchKnowledge } from "../src/services/knowledge.js";
import { db } from "../src/db/client.js";
import { embeddings } from "../src/db/schema.js";
import { createActor } from "../src/services/actors.js";
import { saveNote } from "../src/services/notes.js";
import { createProject } from "../src/services/projects.js";

const emb = new FakeEmbedder(1024);


test("indexed vault content is retrievable and ranked", async () => {
  // FakeEmbedder hashes text, so identical text yields an identical vector (cosine
  // distance 0). The content must be unique per run — otherwise duplicate-content
  // rows from earlier runs in the shared embeddings table also sit at distance 0 and
  // crowd this run's file out of the top-`limit`. A unique marker guarantees exactly
  // one distance-0 row (this run's), so querying that exact text ranks it first.
  const uniq = `run-${Date.now()}-${Math.round(performance.now() * 1000)}`;
  const content = `# Backups ${uniq}\nRun pg_dump nightly to the NAS share.`;
  const p = `note-${uniq}.md`;
  await upsertVaultFile(p, content, emb);
  const hits = await searchKnowledge(content, { limit: 20 }, emb);
  expect(hits.length).toBeGreaterThan(0);
  const mine = hits.find((h) => h.sourceRef === p);
  expect(mine).toBeDefined();
  expect(mine!.citation).toBe(p);
});

test("secrets are redacted before indexing (vault and note)", async () => {
  const uniq = `run-${Date.now()}-${Math.round(performance.now() * 1000)}`;
  const key = "sk-abcdefghij0123456789";
  const content = `# Creds ${uniq}\ntoken is ${key} do not share`;
  const p = `secret-${uniq}.md`;
  await upsertVaultFile(p, content, emb);
  const hits = await searchKnowledge(content, { limit: 20 }, emb);
  const mine = hits.find((h) => h.sourceRef === p);
  expect(mine).toBeDefined();
  expect(mine!.content).not.toContain(key);
  expect(mine!.content).toContain("[redacted]");

  const { actor } = await createActor({ name: `secnote-${uniq}`, kind: "agent" });
  const noteBody = `note secret ${uniq} ${key}`;
  const note = await saveNote(actor.id, { body: noteBody, scope: "global" }, emb);
  const noteHits = await searchKnowledge(noteBody, { limit: 20 }, emb);
  const mineNote = noteHits.find((h) => h.sourceRef === note.id);
  expect(mineNote).toBeDefined();
  expect(mineNote!.content).not.toContain(key);
  expect(mineNote!.content).toContain("[redacted]");
});

test("search results carry provenance and recency-decayed score", async () => {
  // This file is serialized via vitest.workspace.ts (fileParallelism: false in the
  // "vector" pool) because searchKnowledge queries the shared embeddings table via
  // HNSW approximate search. Under parallel load, rows written by other files can
  // crowd these two out of the ANN candidate pool — a structural constraint of
  // approximate nearest-neighbor indexes, not a bug. The project-scoping below
  // narrows the search but cannot fully isolate because searchKnowledge's projectId
  // filter includes global rows; serialization is the primary fix.
  const uniq = `run-${Date.now()}-${Math.round(performance.now() * 1000)}`;
  const project = await createProject({ key: `ks-${uniq}`, name: "KS" });
  const content = `# Recency ${uniq}\nidentical content for decay comparison.`;
  const fresh = `${project.id}:fresh-${uniq}.md`;
  const stale = `${project.id}:stale-${uniq}.md`;
  await upsertVaultFile(fresh, content, emb);
  await upsertVaultFile(stale, content, emb);
  // 30 days, not 300. Decay is 1/(1 + age_days/90), so 300 days scores 0.23x and
  // the stale row gets re-ranked out of the final top-20 by any fresher rows other
  // test files write mid-run — that is what made this fail intermittently, on a
  // fresh CI database too. 30 days gives 0.75x: comfortably inside the window and
  // still strictly below the fresh copy, which is what the test is actually about.
  await db.update(embeddings)
    .set({ createdAt: new Date(Date.now() - 30 * 86400_000) })
    .where(eq(embeddings.sourceRef, stale));

  const hits = await searchKnowledge(content, { limit: 20, projectId: project.id }, emb);
  const freshHit = hits.find((h) => h.sourceRef === fresh);
  const staleHit = hits.find((h) => h.sourceRef === stale);
  expect(freshHit).toBeDefined();
  expect(staleHit).toBeDefined();
  expect(typeof freshHit!.createdAt).toBe("string");
  expect(freshHit!.score).toBeGreaterThan(staleHit!.score);
});

test("dim mismatch rows are excluded", async () => {
  // Index at 1024 dims, then query with a 512-dim embedder. No 512-dim rows
  // exist anywhere in the store, and the 1024-dim rows must be filtered out,
  // so the result is empty (proves the dim filter, not just no-throw).
  await upsertVaultFile(`dim-${Date.now()}.md`, "# X\nsome indexed content", emb);
  const small = new FakeEmbedder(512);
  const hits = await searchKnowledge("some indexed content", { limit: 20 }, small);
  expect(hits.length).toBe(0);
});
