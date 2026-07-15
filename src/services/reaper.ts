import { and, eq, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { tickets } from "../db/schema.js";
import { addComment } from "./comments.js";
import { updateTicket } from "./tickets.js";
import { listActors } from "./actors.js";
import { StaleVersionError } from "./errors.js";

const REAP_COMMENT = "reaper: stale in_progress ticket bounced back to planned (worker likely died)";

// Boot-time sweep: a relay/forge worker that dies hard leaves its ticket stuck
// in_progress forever. Bounce anything untouched past maxAgeMs back to planned.
export async function reapStaleTickets(maxAgeMs = 2 * 60 * 60_000): Promise<number> {
  const admin = (await listActors()).find((a) => a.role === "admin");
  if (!admin) return 0;

  const cutoff = new Date(Date.now() - maxAgeMs);
  const stale = await db.select().from(tickets)
    .where(and(eq(tickets.status, "in_progress"), lt(tickets.updatedAt, cutoff)));

  let count = 0;
  for (const ticket of stale) {
    try {
      await addComment(admin.id, ticket.id, REAP_COMMENT, "comment");
      await updateTicket(admin.id, ticket.id, ticket.version, { status: "planned" });
      count++;
    } catch (e) {
      if (e instanceof StaleVersionError) continue; // someone else moved it - good
      // ponytail: swallow unexpected per-ticket errors too; boot must never crash on this
    }
  }
  return count;
}
