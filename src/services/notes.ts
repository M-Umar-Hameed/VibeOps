import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { notes, events, tickets, projects, type Note } from "../db/schema.js";
import { NotFoundError } from "./errors.js";
import { insertNoteEmbedding } from "./knowledge.js";
import { getEmbedder, type Embedder } from "../knowledge/embedder.js";

export async function saveNote(
  actorId: string,
  input: { body: string; scope: "global" | "project" | "ticket"; refId?: string },
  embedder: Embedder = getEmbedder(),
): Promise<Note> {
  if (input.scope !== "global") {
    if (!input.refId) throw new NotFoundError(`${input.scope} note requires refId`);
    const tbl = input.scope === "project" ? projects : tickets;
    const [row] = await db.select({ id: tbl.id }).from(tbl).where(eq(tbl.id, input.refId)).limit(1);
    if (!row) throw new NotFoundError(`${input.scope} ${input.refId}`);
  }

  const note = await db.transaction(async (tx) => {
    const [n] = await tx.insert(notes).values({
      actorId, body: input.body, scope: input.scope, refId: input.refId, indexed: false,
    }).returning();
    await tx.insert(events).values({ actorId, noteId: n.id, action: "note.saved" });
    return n;
  });

  try {
    await insertNoteEmbedding(note.id, note.body, embedder);
    const [updated] = await db.update(notes)
      .set({ indexed: true }).where(eq(notes.id, note.id)).returning();
    return updated;
  } catch {
    return note; // truth kept; sweep will re-index
  }
}

export async function sweepUnindexedNotes(embedder: Embedder = getEmbedder()): Promise<number> {
  const pending = await db.select().from(notes).where(eq(notes.indexed, false));
  let done = 0;
  for (const n of pending) {
    try {
      await insertNoteEmbedding(n.id, n.body, embedder);
      await db.update(notes).set({ indexed: true }).where(eq(notes.id, n.id));
      done++;
    } catch { /* leave for next sweep */ }
  }
  return done;
}
