import { expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { embeddings } from "../src/db/schema.js";
import { upsertSourceDoc, getKnowledgeSource } from "../src/services/knowledge.js";
import { FakeEmbedder } from "../src/knowledge/embedder.js";
import { snapshot } from "../src/services/metrics.js";

const emb = new FakeEmbedder(1024);
const embedCount = () => snapshot().counters["embed.chunks"] ?? 0;
const uniqRef = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
// chunkMarkdown flushes at each heading, so this yields one chunk per entry.
const doc = (parts: string[]) => parts.map((c, i) => `# H${i}\n${c}`).join("\n\n");

async function rows(kind: "repo" | "session", ref: string) {
  return db.select({ id: embeddings.id, chunkIndex: embeddings.chunkIndex, content: embeddings.content })
    .from(embeddings).where(and(eq(embeddings.sourceKind, kind), eq(embeddings.sourceRef, ref)));
}

test("append: re-ingest with one appended chunk embeds exactly 1, reuses 3, deletes 0", async () => {
  const ref = uniqRef("inc-append");
  const base = ["alpha one", "bravo two", "charlie three"];
  const b1 = embedCount();
  const n1 = await upsertSourceDoc("repo", ref, doc(base), emb);
  expect(embedCount() - b1).toBe(3);
  expect(n1).toBe(3);
  const before = await rows("repo", ref);
  expect(before.length).toBe(3);
  const idsBefore = new Set(before.map((r) => r.id));

  const b2 = embedCount();
  const n2 = await upsertSourceDoc("repo", ref, doc([...base, "delta four"]), emb);
  expect(embedCount() - b2).toBe(1); // mutation probe: delete-all-embed-all => 4, fails here
  expect(n2).toBe(1);
  const after = await rows("repo", ref);
  expect(after.length).toBe(4);
  expect(after.filter((r) => idsBefore.has(r.id)).length).toBe(3); // 3 reused, 0 deleted
});

test("edit middle chunk: exactly 1 delete + 1 embed; outer two row ids unchanged", async () => {
  const ref = uniqRef("inc-mid");
  await upsertSourceDoc("repo", ref, doc(["alpha one", "bravo two", "charlie three"]), emb);
  const before = await rows("repo", ref);
  const idAt = (i: number) => before.find((r) => r.chunkIndex === i)!.id;
  const id0 = idAt(0), id1 = idAt(1), id2 = idAt(2);

  const b = embedCount();
  const n = await upsertSourceDoc("repo", ref, doc(["alpha one", "bravo TWO changed", "charlie three"]), emb);
  expect(embedCount() - b).toBe(1);
  expect(n).toBe(1);
  const after = await rows("repo", ref);
  expect(after.length).toBe(3);
  expect(after.find((r) => r.chunkIndex === 0)!.id).toBe(id0);
  expect(after.find((r) => r.chunkIndex === 2)!.id).toBe(id2);
  expect(after.find((r) => r.chunkIndex === 1)!.id).not.toBe(id1); // middle replaced
});

test("re-ingest identical doc embeds nothing", async () => {
  const ref = uniqRef("inc-idem");
  const d = doc(["alpha one", "bravo two", "charlie three"]);
  await upsertSourceDoc("repo", ref, d, emb);
  const b = embedCount();
  const n = await upsertSourceDoc("repo", ref, d, emb);
  expect(embedCount() - b).toBe(0);
  expect(n).toBe(0);
});

test("document order preserved after incremental re-ingest", async () => {
  const ref = uniqRef("inc-order");
  await upsertSourceDoc("session", ref, doc(["first aaa", "second bbb", "third ccc"]), emb);
  await upsertSourceDoc("session", ref, doc(["first aaa", "second CHANGED", "third ccc", "fourth ddd"]), emb);
  const text = await getKnowledgeSource("session", ref); // reassembles by chunkIndex
  const iF = text.indexOf("first aaa"), iC = text.indexOf("second CHANGED");
  const iT = text.indexOf("third ccc"), iD = text.indexOf("fourth ddd");
  expect(iF).toBeGreaterThanOrEqual(0);
  expect(iF).toBeLessThan(iC);
  expect(iC).toBeLessThan(iT);
  expect(iT).toBeLessThan(iD);
});
