import { expect, test } from "vitest";
import { db } from "../src/db/client.js";
import { projects } from "../src/db/schema.js";
import { createActor } from "../src/services/actors.js";
import { app } from "../src/api/app.js";

test("full REST flow: auth, create, stale update -> 409", async () => {
  const { apiKey } = await createActor({ name: "api", kind: "human" });
  const [proj] = await db.insert(projects)
    .values({ key: `p-${Date.now()}-${Math.random()}`, name: "P" }).returning();
  const h = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  const unauth = await app.request("/tickets", { method: "POST", body: "{}" });
  expect(unauth.status).toBe(401);

  const created = await app.request("/tickets", {
    method: "POST", headers: h,
    body: JSON.stringify({ projectId: proj.id, title: "via api" }),
  });
  expect(created.status).toBe(201);
  const ticket = await created.json();

  await app.request(`/tickets/${ticket.id}`, {
    method: "PATCH", headers: h,
    body: JSON.stringify({ expectedVersion: 1, status: "closed" }),
  });
  const stale = await app.request(`/tickets/${ticket.id}`, {
    method: "PATCH", headers: h,
    body: JSON.stringify({ expectedVersion: 1, title: "again" }),
  });
  expect(stale.status).toBe(409);
});
