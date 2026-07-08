import { asc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { comments, tickets, events, type Comment } from "../db/schema.js";
import { NotFoundError } from "./errors.js";

export async function listComments(ticketId: string): Promise<Comment[]> {
  return db.select().from(comments).where(eq(comments.ticketId, ticketId)).orderBy(asc(comments.createdAt));
}

export async function addComment(
  actorId: string, ticketId: string, body: string,
): Promise<Comment> {
  return db.transaction(async (tx) => {
    const [t] = await tx.select({ id: tickets.id }).from(tickets)
      .where(eq(tickets.id, ticketId)).limit(1);
    if (!t) throw new NotFoundError(`ticket ${ticketId}`);
    const [comment] = await tx.insert(comments)
      .values({ ticketId, authorId: actorId, body }).returning();
    await tx.insert(events).values({
      actorId, ticketId, action: "comment.added",
      changes: { comment: { from: null, to: comment.id } },
    });
    return comment;
  });
}
