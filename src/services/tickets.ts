import { db } from "../db/client.js";
import { tickets, events, type Ticket } from "../db/schema.js";

export async function createTicket(
  actorId: string,
  input: {
    projectId: string; title: string; body?: string;
    priority?: "low" | "normal" | "high"; assigneeId?: string;
  },
): Promise<Ticket> {
  return db.transaction(async (tx) => {
    const [ticket] = await tx.insert(tickets).values({
      projectId: input.projectId, title: input.title, body: input.body ?? "",
      priority: input.priority ?? "normal", assigneeId: input.assigneeId,
    }).returning();
    await tx.insert(events).values({
      actorId, ticketId: ticket.id, action: "ticket.created",
      changes: { title: { from: null, to: ticket.title } },
    });
    return ticket;
  });
}
