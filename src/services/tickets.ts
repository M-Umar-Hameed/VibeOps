import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { tickets, events, type Ticket } from "../db/schema.js";
import { NotFoundError, StaleVersionError } from "./errors.js";

export async function createTicket(
  actorId: string,
  input: {
    projectId: string; title: string; body?: string;
    priority?: "low" | "normal" | "high"; assigneeId?: string;
    status?: "open" | "in_progress" | "closed" | "planned" | "review";
  },
): Promise<Ticket> {
  return db.transaction(async (tx) => {
    const [ticket] = await tx.insert(tickets).values({
      projectId: input.projectId, title: input.title, body: input.body ?? "",
      priority: input.priority ?? "normal", assigneeId: input.assigneeId, status: input.status,
    }).returning();
    await tx.insert(events).values({
      actorId, ticketId: ticket.id, action: "ticket.created",
      changes: { title: { from: null, to: ticket.title } },
    });
    return ticket;
  });
}

export async function updateTicket(
  actorId: string,
  id: string,
  expectedVersion: number,
  patch: Partial<{
    title: string; body: string;
    status: "open" | "in_progress" | "closed" | "planned" | "review";
    priority: "low" | "normal" | "high";
    assigneeId: string | null;
  }>,
): Promise<Ticket> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(tickets).where(eq(tickets.id, id)).limit(1);
    if (!current) throw new NotFoundError(`ticket ${id}`);
    if (current.version !== expectedVersion) {
      throw new StaleVersionError(expectedVersion, current.version);
    }

    // Whitelist editable fields so a caller can't mass-assign columns like createdAt/projectId.
    const ALLOWED = ["title", "body", "status", "priority", "assigneeId"] as const;
    const clean = Object.fromEntries(
      Object.entries(patch).filter(([k]) => (ALLOWED as readonly string[]).includes(k)),
    );

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, v] of Object.entries(clean)) {
      if (v !== undefined && (current as Record<string, unknown>)[k] !== v) {
        changes[k] = { from: (current as Record<string, unknown>)[k], to: v };
      }
    }

    // Guarded UPDATE: version in WHERE closes the check-then-write race.
    const [updated] = await tx.update(tickets)
      .set({ ...clean, version: current.version + 1, updatedAt: new Date() })
      .where(and(eq(tickets.id, id), eq(tickets.version, expectedVersion)))
      .returning();
    if (!updated) throw new StaleVersionError(expectedVersion, current.version);

    await tx.insert(events).values({
      actorId, ticketId: id, action: "ticket.updated", changes,
    });
    return updated;
  });
}
