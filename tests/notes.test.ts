import { expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { notes, events, embeddings } from "../src/db/schema.js";
import { createActor } from "../src/services/actors.js";
import { saveNote, sweepUnindexedNotes } from "../src/services/notes.js";
import { FakeEmbedder } from "../src/knowledge/embedder.js";
import { NotFoundError } from "../src/services/errors.js";

const emb = new FakeEmbedder(1024);

test("saveNote writes note + audit event + embedding", async () => {
  const { actor } = await createActor({ name: "mem", kind: "agent" });
  const note = await saveNote(actor.id, { body: "chose port 5433", scope: "global" }, emb);
  expect(note.indexed).toBe(true);

  const evts = await db.select().from(events).where(eq(events.noteId, note.id));
  expect(evts).toHaveLength(1);
  expect(evts[0].action).toBe("note.saved");
  expect(evts[0].ticketId).toBeNull();

  const embs = await db.select().from(embeddings).where(eq(embeddings.sourceRef, note.id));
  expect(embs.length).toBeGreaterThan(0);
});

test("embedding failure keeps the note un-indexed, then sweep fixes it", async () => {
  const { actor } = await createActor({ name: "mem2", kind: "agent" });
  const boom: any = { model: "boom", dim: 1024, embed: async () => { throw new Error("api down"); } };
  const note = await saveNote(actor.id, { body: "keep me", scope: "global" }, boom);
  expect(note.indexed).toBe(false);
  const evts = await db.select().from(events).where(eq(events.noteId, note.id));
  expect(evts).toHaveLength(1); // audited even though embedding failed

  const n = await sweepUnindexedNotes(emb);
  expect(n).toBeGreaterThanOrEqual(1);
  const [after] = await db.select().from(notes).where(eq(notes.id, note.id));
  expect(after.indexed).toBe(true);
});

test("project-scoped note with bad refId throws NotFoundError", async () => {
  const { actor } = await createActor({ name: "mem3", kind: "agent" });
  await expect(
    saveNote(actor.id, { body: "x", scope: "project", refId: "00000000-0000-0000-0000-000000000000" }, emb),
  ).rejects.toBeInstanceOf(NotFoundError);
});
