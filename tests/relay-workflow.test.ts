import { expect, test } from "vitest";
import { createActor } from "../src/services/actors.js";
import { app } from "../src/api/app.js";

async function setup() {
  const { apiKey } = await createActor({ name: `relay-${Date.now()}-${Math.random()}`, kind: "human" });
  const h = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  const proj = await app.request("/projects", {
    method: "POST", headers: h,
    body: JSON.stringify({ key: `relay-p-${Date.now()}-${Math.random()}`, name: "Relay" }),
  });
  const project = await proj.json();

  const ticketRes = await app.request("/tickets", {
    method: "POST", headers: h,
    body: JSON.stringify({ projectId: project.id, title: "Pipeline ticket" }),
  });
  const ticket = await ticketRes.json();

  return { h, ticket };
}

test("REST: ticket status walks open -> planned -> review", async () => {
  const { h, ticket } = await setup();

  const toPlanned = await app.request(`/tickets/${ticket.id}`, {
    method: "PATCH", headers: h,
    body: JSON.stringify({ expectedVersion: ticket.version, status: "planned" }),
  });
  expect(toPlanned.status).toBe(200);
  const planned = await toPlanned.json();
  expect(planned.status).toBe("planned");

  const toReview = await app.request(`/tickets/${ticket.id}`, {
    method: "PATCH", headers: h,
    body: JSON.stringify({ expectedVersion: planned.version, status: "review" }),
  });
  expect(toReview.status).toBe(200);
  const reviewed = await toReview.json();
  expect(reviewed.status).toBe("review");
});

test("REST: comment kind is accepted, defaulted, echoed, and validated", async () => {
  const { h, ticket } = await setup();

  const withKind = await app.request(`/tickets/${ticket.id}/comments`, {
    method: "POST", headers: h,
    body: JSON.stringify({ body: "here's the plan", kind: "plan" }),
  });
  expect(withKind.status).toBe(201);
  const planComment = await withKind.json();
  expect(planComment.kind).toBe("plan");

  const withoutKind = await app.request(`/tickets/${ticket.id}/comments`, {
    method: "POST", headers: h,
    body: JSON.stringify({ body: "plain comment" }),
  });
  expect((await withoutKind.json()).kind).toBe("comment");

  const invalid = await app.request(`/tickets/${ticket.id}/comments`, {
    method: "POST", headers: h,
    body: JSON.stringify({ body: "bad", kind: "bogus" }),
  });
  expect(invalid.status).toBe(400);

  const listed = await app.request(`/tickets/${ticket.id}/comments`, { headers: h });
  const comments = await listed.json();
  expect(comments.find((c: { id: string }) => c.id === planComment.id)?.kind).toBe("plan");
});
