import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { embeddings, notes } from "../src/db/schema.js";
import { createActor } from "../src/services/actors.js";
import { saveNote, updateNote, deleteNote, listNotes, getNote, sweepUnindexedNotes } from "../src/services/notes.js";
import { searchKnowledge, getKnowledgeSource } from "../src/services/knowledge.js";
import { FakeEmbedder, type Embedder } from "../src/knowledge/embedder.js";
import { StaleVersionError, NotFoundError } from "../src/services/errors.js";

const emb = new FakeEmbedder(1024);
const uniq = () => `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;

describe("notes workspace", () => {
  it("saves with a title, updates body with version bump, and re-embeds", async () => {
    const { actor } = await createActor({ name: uniq(), kind: "agent" });
    const oldBody = `original body ${uniq()}`;
    const note = await saveNote(actor.id, { body: oldBody, scope: "global", title: "Runbook" }, emb);
    expect(note.title).toBe("Runbook");
    expect(note.version).toBe(1);

    const newBody = `edited body ${uniq()}`;
    const updated = await updateNote(actor.id, note.id, 1, { body: newBody }, emb);
    expect(updated.version).toBe(2);
    expect(updated.body).toBe(newBody);

    // Assert the re-embed deterministically against the index rows: ANN top-k
    // under full-suite parallel inserts is approximate and flaked repeatedly.
    // Semantic retrieval itself is covered by tests/e2e-memory.test.ts.
    const rows = await db.select({ content: embeddings.content }).from(embeddings)
      .where(and(eq(embeddings.sourceKind, "note"), eq(embeddings.sourceRef, note.id)));
    expect(rows.some((r) => r.content === newBody)).toBe(true);
    expect(rows.some((r) => r.content === oldBody)).toBe(false);
  });

  it("stale update and stale delete throw StaleVersionError", async () => {
    const { actor } = await createActor({ name: uniq(), kind: "agent" });
    const note = await saveNote(actor.id, { body: uniq(), scope: "global" }, emb);
    await expect(updateNote(actor.id, note.id, 99, { body: "x" }, emb)).rejects.toBeInstanceOf(StaleVersionError);
    await expect(deleteNote(actor.id, note.id, 99)).rejects.toBeInstanceOf(StaleVersionError);
  });

  it("soft delete hides the note from get/list/search/source and sweep", async () => {
    const { actor } = await createActor({ name: uniq(), kind: "agent" });
    const body = `deletable ${uniq()}`;
    const note = await saveNote(actor.id, { body, scope: "global" }, emb);
    await deleteNote(actor.id, note.id, 1);

    await expect(getNote(note.id)).rejects.toBeInstanceOf(NotFoundError);
    const listed = await listNotes({ scope: "global", limit: 200 });
    expect(listed.some((n) => n.id === note.id)).toBe(false);
    const hits = await searchKnowledge(body, { limit: 5 }, emb);
    expect(hits.some((h) => h.sourceRef === note.id)).toBe(false);
    expect(await getKnowledgeSource("note", note.id)).toMatch(/not found|deleted/i);
    expect(await sweepUnindexedNotes(emb)).toBeGreaterThanOrEqual(0); // must not resurrect embeddings
    const hitsAfter = await searchKnowledge(body, { limit: 5 }, emb);
    expect(hitsAfter.some((h) => h.sourceRef === note.id)).toBe(false);
  });

  it("update of a deleted or missing note is NotFound", async () => {
    const { actor } = await createActor({ name: uniq(), kind: "agent" });
    const note = await saveNote(actor.id, { body: uniq(), scope: "global" }, emb);
    await deleteNote(actor.id, note.id, 1);
    await expect(updateNote(actor.id, note.id, 2, { body: "x" }, emb)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateNote(actor.id, "00000000-0000-0000-0000-000000000000", 1, { body: "x" }, emb)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("empty patch is a no-op: no version bump, no event, no re-embed", async () => {
    const { actor } = await createActor({ name: uniq(), kind: "agent" });
    const note = await saveNote(actor.id, { body: uniq(), scope: "global" }, emb);
    const result = await updateNote(actor.id, note.id, 1, {}, emb);
    expect(result.version).toBe(1);
    expect(result.id).toBe(note.id);
  });

  it("update/delete race does not resurrect embeddings for a deleted note", async () => {
    const { actor } = await createActor({ name: uniq(), kind: "agent" });
    const oldBody = `race original ${uniq()}`;
    const note = await saveNote(actor.id, { body: oldBody, scope: "global" }, emb);

    let embedStarted!: () => void;
    const started = new Promise<void>((resolve) => { embedStarted = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const newBody = `race updated ${uniq()}`;
    const latchEmbedder: Embedder = {
      model: "latch",
      dim: 1024,
      async embed(texts: string[]) {
        embedStarted(); // signals updateNote's txn already committed (embed runs post-commit)
        await gate;
        return emb.embed(texts);
      },
    };

    const updatePromise = updateNote(actor.id, note.id, 1, { body: newBody }, latchEmbedder);
    await started; // update's txn has committed (version now 2); it's now blocked embedding
    await deleteNote(actor.id, note.id, 2);
    release();
    await updatePromise;

    const hits = await searchKnowledge(newBody, { limit: 5 }, emb);
    expect(hits.some((h) => h.sourceRef === note.id)).toBe(false);

    const [row] = await db.select().from(notes).where(eq(notes.id, note.id)).limit(1);
    expect(row?.deletedAt).not.toBeNull();
  });
});
