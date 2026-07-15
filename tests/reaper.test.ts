import { expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { createActor } from "../src/services/actors.js";
import { app } from "../src/api/app.js";
import { db } from "../src/db/client.js";
import { tickets } from "../src/db/schema.js";
import { reapStaleTickets } from "../src/services/reaper.js";

async function setup() {
  const { apiKey } = await createActor({ name: `reaper-${Date.now()}-${Math.random()}`, kind: "human" });
  const h = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  return { h };
}

async function makeInProgressTicket(h: Record<string, string>, projectId: string) {
  const ticketRes = await app.request("/tickets", {
    method: "POST", headers: h,
    body: JSON.stringify({ projectId, title: "Worker ticket" }),
  });
  const ticket = await ticketRes.json();

  const patched = await app.request(`/tickets/${ticket.id}`, {
    method: "PATCH", headers: h,
    body: JSON.stringify({ expectedVersion: ticket.version, status: "in_progress" }),
  });
  return patched.json();
}

test("reaper: bounces a stale in_progress ticket back to planned", async () => {
  const { h } = await setup();
  const proj = await app.request("/projects", {
    method: "POST", headers: h,
    body: JSON.stringify({ key: `reaper-p-${Date.now()}-${Math.random()}`, name: "Reaper" }),
  });
  const project = await proj.json();

  const ticket = await makeInProgressTicket(h, project.id);
  const backdated = new Date(Date.now() - 3 * 60 * 60_000);
  await db.update(tickets).set({ updatedAt: backdated }).where(eq(tickets.id, ticket.id));

  const count = await reapStaleTickets();
  expect(count).toBeGreaterThanOrEqual(1);

  const [reaped] = await db.select().from(tickets).where(eq(tickets.id, ticket.id));
  expect(reaped.status).toBe("planned");

  const commentsRes = await app.request(`/tickets/${ticket.id}/comments`, { headers: h });
  const comments = await commentsRes.json();
  expect(comments.some((c: { body: string }) => c.body.includes("reaper: stale in_progress ticket"))).toBe(true);
});

test("reaper: leaves a fresh in_progress ticket untouched", async () => {
  const { h } = await setup();
  const proj = await app.request("/projects", {
    method: "POST", headers: h,
    body: JSON.stringify({ key: `reaper-p-${Date.now()}-${Math.random()}`, name: "Reaper" }),
  });
  const project = await proj.json();

  const ticket = await makeInProgressTicket(h, project.id);

  await reapStaleTickets();

  const [untouched] = await db.select().from(tickets).where(eq(tickets.id, ticket.id));
  expect(untouched.status).toBe("in_progress");
  expect(untouched.version).toBe(ticket.version);
});
