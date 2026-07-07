import { expect, test } from "vitest";
import { db } from "../src/db/client.js";
import { projects } from "../src/db/schema.js";
import { createActor } from "../src/services/actors.js";
import { createTicket, updateTicket } from "../src/services/tickets.js";
import { getTicketHistory, searchTickets } from "../src/services/history.js";

test("history replays create then update in order", async () => {
  const { actor } = await createActor({ name: "h", kind: "human" });
  const [proj] = await db.insert(projects)
    .values({ key: `p-${Date.now()}-${Math.random()}`, name: "P" }).returning();
  const ticket = await createTicket(actor.id, { projectId: proj.id, title: "Searchable widget" });
  await updateTicket(actor.id, ticket.id, 1, { status: "closed" });

  const history = await getTicketHistory(ticket.id);
  expect(history.map((e) => e.action)).toEqual(["ticket.created", "ticket.updated"]);

  const found = await searchTickets("widget");
  expect(found.some((t) => t.id === ticket.id)).toBe(true);
});
