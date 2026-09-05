import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { tickets, events, type Ticket, type Event } from "../db/schema.js";
import { NotFoundError } from "./errors.js";

export async function getTicket(id: string): Promise<Ticket> {
  const [t] = await db.select().from(tickets).where(eq(tickets.id, id)).limit(1);
  if (!t) throw new NotFoundError(`ticket ${id}`);
  return t;
}

export async function getTicketHistory(ticketId: string): Promise<Event[]> {
  return db.select().from(events).where(eq(events.ticketId, ticketId)).orderBy(asc(events.at));
}

export async function listTickets(
  filter: { projectId?: string; status?: string; limit?: number } = {},
): Promise<Ticket[]> {
  let q = db.select().from(tickets).$dynamic();
  const conds = [];
  if (filter.projectId) conds.push(eq(tickets.projectId, filter.projectId));
  if (filter.status) conds.push(sql`${tickets.status} = ${filter.status}`);
  if (conds.length) q = q.where(and(...conds));
  q = q.orderBy(desc(tickets.updatedAt));
  if (filter.limit) q = q.limit(filter.limit);
  return q;
}

export async function searchTickets(term: string): Promise<Ticket[]> {
  const pattern = `%${term}%`;
  return db.select().from(tickets)
    .where(or(ilike(tickets.title, pattern), ilike(tickets.body, pattern)));
}
