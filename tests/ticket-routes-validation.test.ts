import { expect, test } from "vitest";
import { createActor } from "../src/services/actors.js";
import { app } from "../src/api/app.js";

const UNKNOWN_UUID = "00000000-0000-0000-0000-000000000000";

async function admin() {
  const { apiKey } = await createActor({ name: `val-${Date.now()}-${Math.random()}`, kind: "human", role: "admin" });
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function makeProject(h: Record<string, string>) {
  return (await app.request("/projects", {
    method: "POST", headers: h,
    body: JSON.stringify({ key: `pk-${Date.now()}-${Math.random()}`, name: "P" }),
  })).json();
}

test("ticket id routes reject non-uuid id with 400", async () => {
  const h = await admin();
  for (const path of [`/tickets/not-a-uuid/comments`, `/tickets/not-a-uuid/history`]) {
    const res = await app.request(path, { headers: h });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid ticket id");
  }
});

test("comments and history 404 for well-formed unknown ticket id", async () => {
  const h = await admin();
  for (const path of [`/tickets/${UNKNOWN_UUID}/comments`, `/tickets/${UNKNOWN_UUID}/history`]) {
    const res = await app.request(path, { headers: h });
    expect(res.status).toBe(404);
  }
});

test("POST /tickets validates body at the boundary", async () => {
  const h = await admin();

  const empty = await app.request("/tickets", { method: "POST", headers: h, body: "{}" });
  expect(empty.status).toBe(400);
  expect((await empty.json()).error).toContain("projectId");

  const badId = await app.request("/tickets", {
    method: "POST", headers: h, body: JSON.stringify({ projectId: "not-a-uuid", title: "x" }),
  });
  expect(badId.status).toBe(400);
  expect((await badId.json()).error).toContain("projectId");

  const proj = await makeProject(h);
  const blankTitle = await app.request("/tickets", {
    method: "POST", headers: h, body: JSON.stringify({ projectId: proj.id, title: "   " }),
  });
  expect(blankTitle.status).toBe(400);
  expect((await blankTitle.json()).error).toContain("title");

  const unknownProj = await app.request("/tickets", {
    method: "POST", headers: h, body: JSON.stringify({ projectId: UNKNOWN_UUID, title: "x" }),
  });
  expect(unknownProj.status).toBe(404);

  const badJson = await app.request("/tickets", { method: "POST", headers: h, body: "not json" });
  expect(badJson.status).toBe(400);
});

test("POST /tickets happy path still returns 201", async () => {
  const h = await admin();
  const proj = await makeProject(h);
  const res = await app.request("/tickets", {
    method: "POST", headers: h, body: JSON.stringify({ projectId: proj.id, title: "keep working" }),
  });
  expect(res.status).toBe(201);
  expect((await res.json()).title).toBe("keep working");
});

test("POST /projects validates body; duplicate key still 409", async () => {
  const h = await admin();

  const empty = await app.request("/projects", { method: "POST", headers: h, body: "{}" });
  expect(empty.status).toBe(400);

  const key = `dup-${Date.now()}-${Math.random()}`;
  const first = await app.request("/projects", {
    method: "POST", headers: h, body: JSON.stringify({ key, name: "A" }),
  });
  expect(first.status).toBe(201);
  const dup = await app.request("/projects", {
    method: "POST", headers: h, body: JSON.stringify({ key, name: "B" }),
  });
  expect(dup.status).toBe(409);
});

test("DELETE /projects rejects non-uuid with 400, 404 for unknown uuid", async () => {
  const h = await admin();

  const bad = await app.request("/projects/not-a-uuid", { method: "DELETE", headers: h });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toBe("invalid project id");

  const unknown = await app.request(`/projects/${UNKNOWN_UUID}`, { method: "DELETE", headers: h });
  expect(unknown.status).toBe(404);
});

test("POST /notes returns 400 on malformed JSON body", async () => {
  const h = await admin();
  const res = await app.request("/notes", { method: "POST", headers: h, body: "not json" });
  expect(res.status).toBe(400);
});
