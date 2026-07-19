import { expect, test } from "vitest";
import { app } from "../src/api/app.js";
import { createActor } from "../src/services/actors.js";

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

test("member surface audit: admin surfaces return 403", async () => {
  const { apiKey: memberKey } = await createActor({ name: uniq("audit-member"), kind: "agent" });
  const h = { Authorization: `Bearer ${memberKey}`, "Content-Type": "application/json" };

  const settingsKey = uniq("audit.setting");
  
  const checks: [string, RequestInit][] = [
    [`/settings/${settingsKey}`, { headers: h }],
    [`/settings/${settingsKey}`, { method: "PATCH", headers: h, body: JSON.stringify({ value: "x" }) }],
    ["/actors", { method: "POST", headers: h, body: JSON.stringify({ name: uniq("nope"), kind: "agent" }) }],
    ["/system/logs", { headers: h }],
    ["/forge/pipeline", { method: "POST", headers: h, body: JSON.stringify({ ticketId: "x", planAgent: "a", workAgent: "b", reviewAgent: "c" }) }],
    ["/forge/tickets/00000000-0000-0000-0000-000000000000/promote", { method: "POST", headers: h }],
    ["/forge/tickets/00000000-0000-0000-0000-000000000000/approve", { method: "POST", headers: h }],
    ["/forge/doctor", { headers: h }],
    ["/forge/tickets/00000000-0000-0000-0000-000000000000/resume", { method: "POST", headers: h }],
    ["/forge/tickets/00000000-0000-0000-0000-000000000000/sandbox", { headers: h }],
    ["/forge/tickets/00000000-0000-0000-0000-000000000000/diff", { headers: h }],
    ["/forge/tickets/00000000-0000-0000-0000-000000000000/explain-diff", { method: "POST", headers: h, body: JSON.stringify({}) }],
    ["/council/evaluate", { method: "POST", headers: h, body: JSON.stringify({ prompt: "x" }) }],
    ["/council/00000000-0000-0000-0000-000000000000/create-ticket", { method: "POST", headers: h, body: JSON.stringify({ projectId: "x" }) }],
    ["/relay/bootstrap", { method: "POST", headers: h, body: JSON.stringify({}) }],
    ["/ingest/sessions", { method: "POST", headers: h, body: JSON.stringify({ sinceDays: 0 }) }],
    ["/knowledge/obsidian/start", { method: "POST", headers: h, body: JSON.stringify({ vaultPath: "x" }) }],
    ["/knowledge/obsidian/stop", { method: "POST", headers: h, body: JSON.stringify({}) }],
    ["/mcp/install", { method: "POST", headers: h, body: JSON.stringify({ client: "x" }) }],
    ["/relay/agents/x", { method: "PATCH", headers: h, body: JSON.stringify({ roles: ["plan"] }) }],
    ["/projects/scan", { method: "POST", headers: h, body: JSON.stringify({ path: "/nonexistent" }) }],
    ["/projects/import", { method: "POST", headers: h, body: JSON.stringify({ items: [] }) }]
  ];

  for (const [path, init] of checks) {
    const res = await app.request(path, init);
    expect(res.status).toBe(403);
  }
});

test("member surface audit: work surface returns 2xx", async () => {
  const { apiKey: memberKey } = await createActor({ name: uniq("audit-worker"), kind: "human" });
  const h = { Authorization: `Bearer ${memberKey}`, "Content-Type": "application/json" };

  const proj = await (await app.request("/projects", {
    method: "POST", headers: h, body: JSON.stringify({ key: uniq("audit"), name: "Audit Proj" }),
  })).json();

  expect((await app.request("/tickets", { headers: h })).status).toBe(200);

  const ticket = await app.request("/tickets", {
    method: "POST", headers: h, body: JSON.stringify({ projectId: proj.id, title: "work" }),
  });
  expect(ticket.status).toBe(201);
  const t = await ticket.json();

  expect((await app.request(`/tickets/${t.id}/comments`, {
    method: "POST", headers: h, body: JSON.stringify({ body: "hi" }),
  })).status).toBe(201);

  expect((await app.request("/notes", {
    method: "POST", headers: h, body: JSON.stringify({ body: "hi", scope: "global", title: "n" }),
  })).status).toBe(201);

  expect((await app.request("/knowledge?q=x", { headers: h })).status).toBe(200);

  expect((await app.request(`/export/brief?kind=ticket&id=${t.id}`, { headers: h })).status).toBe(200);
});

test("auth rate limit: 20 failures triggers 429 for prefix, valid key ok", async () => {
  const badKey = uniq("bad");
  const badH = { Authorization: `Bearer ${badKey}` };
  
  for (let i = 0; i < 20; i++) {
    const res = await app.request("/system/logs", { headers: badH });
    expect(res.status).toBe(401);
  }

  const res429 = await app.request("/system/logs", { headers: badH });
  expect(res429.status).toBe(429);
  expect(await res429.text()).toBe("Too Many Requests");

  const { apiKey: validKey } = await createActor({ name: uniq("audit-valid"), kind: "agent" });
  const validH = { Authorization: `Bearer ${validKey}` };
  
  // Valid key should still be 403 on system/logs, not 429 or 401
  const resValid = await app.request("/system/logs", { headers: validH });
  expect(resValid.status).toBe(403);
});
