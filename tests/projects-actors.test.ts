import { expect, test } from "vitest";
import { createActor } from "../src/services/actors.js";
import { app } from "../src/api/app.js";

test("projects + actors endpoints: auth, create, list, no key leak", async () => {
  const { apiKey } = await createActor({ name: "p3", kind: "human" });
  const h = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  expect((await app.request("/projects")).status).toBe(401);

  const key = `proj-${Date.now()}`;
  const created = await app.request("/projects", {
    method: "POST", headers: h, body: JSON.stringify({ key, name: "Proj Three" }),
  });
  expect(created.status).toBe(201);

  const dup = await app.request("/projects", {
    method: "POST", headers: h, body: JSON.stringify({ key, name: "again" }),
  });
  expect(dup.status).toBe(409);

  const list = await (await app.request("/projects", { headers: h })).json();
  expect(list.some((p: any) => p.key === key)).toBe(true);

  const actorsList = await (await app.request("/actors", { headers: h })).json();
  expect(actorsList.length).toBeGreaterThan(0);
  expect(actorsList.every((a: any) => !("apiKeyHash" in a))).toBe(true);
});

test("GET /tickets/:id returns a ticket and 404s for a missing id, and lists comments", async () => {
  const { apiKey } = await createActor({ name: "p3b", kind: "human" });
  const h = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const proj = await (await app.request("/projects", {
    method: "POST", headers: h, body: JSON.stringify({ key: `pk-${Date.now()}-${Math.random()}`, name: "P" }),
  })).json();
  const ticket = await (await app.request("/tickets", {
    method: "POST", headers: h, body: JSON.stringify({ projectId: proj.id, title: "read me" }),
  })).json();

  const got = await app.request(`/tickets/${ticket.id}`, { headers: h });
  expect(got.status).toBe(200);
  expect((await got.json()).id).toBe(ticket.id);

  const missing = await app.request(`/tickets/00000000-0000-0000-0000-000000000000`, { headers: h });
  expect(missing.status).toBe(404);

  await app.request(`/tickets/${ticket.id}/comments`, { method: "POST", headers: h, body: JSON.stringify({ body: "hi" }) });
  const list = await (await app.request(`/tickets/${ticket.id}/comments`, { headers: h })).json();
  expect(list.some((cm: any) => cm.body === "hi")).toBe(true);
});
