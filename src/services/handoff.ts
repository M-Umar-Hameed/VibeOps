import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { notes, type Note } from "../db/schema.js";
import { saveNote } from "./notes.js";

// A handoff is the note the next session reads first: "where we left off".
// One per save; /prime shows the newest for the project.
export const HANDOFF_RE = /^\*handoff\b\s*/i;

export async function saveHandoff(actorId: string, projectId: string, body: string): Promise<Note> {
  return saveNote(actorId, { body, scope: "project", refId: projectId, kind: "handoff" });
}

export async function latestHandoff(projectId: string): Promise<Note | null> {
  const [n] = await db.select().from(notes)
    .where(and(eq(notes.kind, "handoff"), eq(notes.scope, "project"), eq(notes.refId, projectId), isNull(notes.deletedAt)))
    .orderBy(desc(notes.createdAt)).limit(1);
  return n ?? null;
}
