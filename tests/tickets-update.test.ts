import { expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { projects, events } from "../src/db/schema.js";
import { createActor } from "../src/services/actors.js";
import { createTicket, updateTicket } from "../src/services/tickets.js";
import { StaleVersionError } from "../src/services/errors.js";

async function setup() {
  const { actor } = await createActor({ name: "u", kind: "human" });
  const [proj] = await db.insert(projects)
    .values({ key: `p-${Date.now()}-${Math.random()}`, name: "P" }).returning();
  const ticket = await createTicket(actor.id, { projectId: proj.id, title: "T" });
  return { actor, ticket };
}

test("update bumps version and records field changes", async () => {
  const { actor, ticket } = await setup();
  const updated = await updateTicket(actor.id, ticket.id, ticket.version, { status: "in_progress" });
  expect(updated.version).toBe(2);
  expect(updated.status).toBe("in_progress");

  const rows = await db.select().from(events).where(eq(events.ticketId, ticket.id));
  const updateRow = rows.find((r) => r.action === "ticket.updated");
  expect(updateRow).toBeDefined();
  expect(updateRow!.changes).toEqual({ status: { from: "open", to: "in_progress" } });
});

test("concurrent stale update is rejected", async () => {
  const { actor, ticket } = await setup();
  await updateTicket(actor.id, ticket.id, 1, { title: "A" }); // now version 2
  await expect(
    updateTicket(actor.id, ticket.id, 1, { title: "B" }), // still expects 1 -> stale
  ).rejects.toBeInstanceOf(StaleVersionError);
});
