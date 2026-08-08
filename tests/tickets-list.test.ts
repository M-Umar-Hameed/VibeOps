import { expect, test } from "vitest";
import { db } from "../src/db/client.js";
import { projects, tickets } from "../src/db/schema.js";
import { createActor } from "../src/services/actors.js";
import { app } from "../src/api/app.js";

async function setup(n: number) {
  const { apiKey } = await createActor({ name: `list-${Date.now()}-${Math.random()}`, kind: "human" });
  const [proj] = await db.insert(projects)
    .values({ key: `pl-${Date.now()}-${Math.random()}`, name: "P" }).returning();
  if (n) {
    await db.insert(tickets).values(
      Array.from({ length: n }, (_, i) => ({ projectId: proj.id, title: `t${i}` })),
    );
  }
  return { proj, h: { Authorization: `Bearer ${apiKey}` } };
}

test("limit honored: returns exactly 5 when more exist", async () => {
  const { proj, h } = await setup(6);
  const res = await app.request(`/tickets?projectId=${proj.id}&limit=5`, { headers: h });
  expect(res.status).toBe(200);
  expect(await res.json()).toHaveLength(5);
});

test("GET /tickets with no limit returns ALL matching tickets", async () => {
  const { proj, h } = await setup(201);
  const res = await app.request(`/tickets?projectId=${proj.id}`, { headers: h });
  expect(res.status).toBe(200);
  expect(await res.json()).toHaveLength(201);
});

test("bogus limit behaves as if no limit was passed", async () => {
  const { proj, h } = await setup(201);
  for (const q of ["abc", "-1", "0"]) {
    const res = await app.request(`/tickets?projectId=${proj.id}&limit=${q}`, { headers: h });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(201);
  }
});

test("limit above the max is clamped to the max", async () => {
  const { proj, h } = await setup(201);
  const res = await app.request(`/tickets?projectId=${proj.id}&limit=999999`, { headers: h });
  expect(res.status).toBe(200);
  expect(await res.json()).toHaveLength(200);
});

test("malformed id -> 400, well-formed unknown id -> 404", async () => {
  const { h } = await setup(0);
  const bad = await app.request(`/tickets/not-a-uuid`, { headers: h });
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({ error: "invalid ticket id" });
  const unknown = await app.request(`/tickets/11111111-1111-1111-1111-111111111111`, { headers: h });
  expect(unknown.status).toBe(404);
});
