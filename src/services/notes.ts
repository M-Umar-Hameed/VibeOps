import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { notes, events, tickets, projects, embeddings, type Note } from "../db/schema.js";
import { NotFoundError, StaleVersionError } from "./errors.js";
import { insertNoteEmbedding } from "./knowledge.js";
import { getEmbedder, type Embedder } from "../knowledge/embedder.js";

export async function saveNote(
  actorId: string,
  input: { body: string; scope: "global" | "project" | "ticket"; refId?: string; title?: string },
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
      actorId, body: input.body, scope: input.scope, refId: input.refId, title: input.title, indexed: false,
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
  const pending = await db.select().from(notes).where(and(eq(notes.indexed, false), isNull(notes.deletedAt)));
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

export async function updateNote(
  actorId: string,
  id: string,
  expectedVersion: number,
  patch: { title?: string; body?: string },
  embedder: Embedder = getEmbedder(),
): Promise<Note> {
  const note = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(notes).where(eq(notes.id, id)).limit(1);
    if (!current || current.deletedAt) throw new NotFoundError(`note ${id}`);
    if (current.version !== expectedVersion) throw new StaleVersionError(expectedVersion, current.version);

    const ALLOWED = ["title", "body"] as const;
    const clean = Object.fromEntries(
      Object.entries(patch).filter(([k, v]) => (ALLOWED as readonly string[]).includes(k) && v !== undefined),
    );
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, v] of Object.entries(clean)) {
      if ((current as Record<string, unknown>)[k] !== v) changes[k] = { from: (current as Record<string, unknown>)[k], to: v };
    }

    const [updated] = await tx.update(notes)
      .set({ ...clean, version: current.version + 1, indexed: false })
      .where(and(eq(notes.id, id), eq(notes.version, expectedVersion)))
      .returning();
    if (!updated) throw new StaleVersionError(expectedVersion, current.version);
    await tx.insert(events).values({ actorId, noteId: id, action: "note.updated", changes });
    return updated;
  });

  try {
    await insertNoteEmbedding(note.id, note.body, embedder);
    const [indexed] = await db.update(notes).set({ indexed: true }).where(eq(notes.id, note.id)).returning();
    return indexed;
  } catch {
    return note; // sweep re-embeds
  }
}

export async function deleteNote(actorId: string, id: string, expectedVersion: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(notes).where(eq(notes.id, id)).limit(1);
    if (!current || current.deletedAt) throw new NotFoundError(`note ${id}`);
    if (current.version !== expectedVersion) throw new StaleVersionError(expectedVersion, current.version);
    const [updated] = await tx.update(notes)
      .set({ deletedAt: new Date(), version: current.version + 1 })
      .where(and(eq(notes.id, id), eq(notes.version, expectedVersion)))
      .returning();
    if (!updated) throw new StaleVersionError(expectedVersion, current.version);
    await tx.insert(events).values({ actorId, noteId: id, action: "note.deleted" });
    // Deleted docs must leave the index (same transaction: no window where search serves a deleted note).
    await tx.delete(embeddings).where(and(eq(embeddings.sourceKind, "note"), eq(embeddings.sourceRef, id)));
  });
}

export async function listNotes(
  filter: { scope?: "global" | "project" | "ticket"; refId?: string; limit?: number } = {},
): Promise<Note[]> {
  const conds = [isNull(notes.deletedAt)];
  if (filter.scope) conds.push(eq(notes.scope, filter.scope));
  if (filter.refId) conds.push(eq(notes.refId, filter.refId));
  return db.select().from(notes).where(and(...conds))
    .orderBy(desc(notes.createdAt)).limit(filter.limit ?? 50);
}

export async function getNote(id: string): Promise<Note> {
  const [row] = await db.select().from(notes).where(and(eq(notes.id, id), isNull(notes.deletedAt))).limit(1);
  if (!row) throw new NotFoundError(`note ${id}`);
  return row;
}
