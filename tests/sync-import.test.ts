import { expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { projects, events, tickets, syncLinks } from "../src/db/schema.js";
import { runSync } from "../src/sync/import.js";
import type { SourceConnector, ExternalTicket } from "../src/sync/connector.js";

async function newProject() {
  const [p] = await db.insert(projects).values({ key: `p-${Date.now()}-${Math.random()}`, name: "P" }).returning();
  return p.id;
}
function fake(source: string, list: ExternalTicket[]): SourceConnector {
  return { source, listExternalTickets: async () => list };
}

test("import creates, is idempotent, updates, and dedupes comments — all audited", async () => {
  const projectId = await newProject();
  const source = `src-${Date.now()}`;
  const ext: ExternalTicket = {
    externalId: "x#1", title: "First", body: "b", status: "open", updatedAt: "2026-01-01T00:00:00Z",
    comments: [{ externalId: "x#c1", author: "a", body: "hi", createdAt: "2026-01-01T01:00:00Z" }],
  };

  const r1 = await runSync(fake(source, [ext]), { projectId });
  expect(r1.created).toBe(1);
  expect(r1.commentsAdded).toBe(1);

  const [link] = await db.select().from(syncLinks).where(and(eq(syncLinks.source, source), eq(syncLinks.externalId, "x#1")));
  expect(link).toBeDefined();
  const evts = await db.select().from(events).where(eq(events.ticketId, link.ticketId));
  expect(evts.some((e) => e.action === "ticket.created")).toBe(true);
  expect(evts.some((e) => e.action === "comment.added")).toBe(true);

  const r2 = await runSync(fake(source, [ext]), { projectId }); // unchanged
  expect(r2.created).toBe(0);
  expect(r2.skipped).toBe(1);
  expect(r2.commentsAdded).toBe(0); // comment already linked

  const ext2 = { ...ext, title: "First (edited)", updatedAt: "2026-02-01T00:00:00Z" };
  const r3 = await runSync(fake(source, [ext2]), { projectId }); // newer
  expect(r3.updated).toBe(1);
  const [t] = await db.select().from(tickets).where(eq(tickets.id, link.ticketId));
  expect(t.title).toBe("First (edited)");
});

test("closed external ticket imports as closed", async () => {
  const projectId = await newProject();
  const source = `src2-${Date.now()}`;
  const ext: ExternalTicket = { externalId: "y#9", title: "done", body: "", status: "closed", updatedAt: "2026-01-01T00:00:00Z", comments: [] };
  await runSync(fake(source, [ext]), { projectId });
  const [link] = await db.select().from(syncLinks).where(and(eq(syncLinks.source, source), eq(syncLinks.externalId, "y#9")));
  const [t] = await db.select().from(tickets).where(eq(tickets.id, link.ticketId));
  expect(t.status).toBe("closed");
});
