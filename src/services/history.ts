import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { tickets, events, type Ticket, type Event } from "../db/schema.js";

export async function getTicketHistory(ticketId: string): Promise<Event[]> {
  return db.select().from(events).where(eq(events.ticketId, ticketId)).orderBy(asc(events.at));
}

export async function listTickets(
  filter: { projectId?: string; status?: string } = {},
): Promise<Ticket[]> {
  const conds = [];
  if (filter.projectId) conds.push(eq(tickets.projectId, filter.projectId));
  if (filter.status) conds.push(sql`${tickets.status} = ${filter.status}`);
  return conds.length
    ? db.select().from(tickets).where(and(...conds))
    : db.select().from(tickets);
}

export async function searchTickets(term: string): Promise<Ticket[]> {
  const pattern = `%${term}%`;
  return db.select().from(tickets)
    .where(or(ilike(tickets.title, pattern), ilike(tickets.body, pattern)));
}
