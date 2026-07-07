import { expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { projects, events } from "../src/db/schema.js";
import { createActor } from "../src/services/actors.js";
import { createTicket } from "../src/services/tickets.js";

test("creating a ticket writes an audit event in the same transaction", async () => {
  const { actor } = await createActor({ name: "author", kind: "human" });
  const [proj] = await db.insert(projects)
    .values({ key: `p-${Date.now()}`, name: "Proj" }).returning();

  const ticket = await createTicket(actor.id, { projectId: proj.id, title: "First" });
  expect(ticket.version).toBe(1);
  expect(ticket.status).toBe("open");

  const evts = await db.select().from(events).where(eq(events.ticketId, ticket.id));
  expect(evts).toHaveLength(1);
  expect(evts[0].action).toBe("ticket.created");
  expect(evts[0].actorId).toBe(actor.id);
});
