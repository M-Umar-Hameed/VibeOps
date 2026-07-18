import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { createTicket } from "../src/services/tickets.js";
import { app } from "../src/api/app.js";

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

test("guarded routes: 403 for member, non-403 for admin", { timeout: 60_000 }, async () => {
  const { apiKey: adminKey } = await createActor({ name: uniq("authz-admin"), kind: "human", role: "admin" });
  const { apiKey: memberKey } = await createActor({ name: uniq("authz-member"), kind: "agent" });
  const adminH = { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" };
  const memberH = { Authorization: `Bearer ${memberKey}`, "Content-Type": "application/json" };

  const settingsKey = uniq("authz.setting");

  const adminGet = await app.request(`/settings/${settingsKey}`, { headers: adminH });
  expect(adminGet.status).toBe(200);
  expect(await adminGet.json()).toEqual({ value: null });

  expect((await app.request(`/settings/${settingsKey}`, {
    method: "PATCH", headers: adminH, body: JSON.stringify({ value: "x" }),
  })).status).toBe(200);

  const tmpVault = mkdtempSync(join(tmpdir(), "authz-vault-"));
  expect((await app.request("/knowledge/obsidian/start", {
    method: "POST", headers: adminH, body: JSON.stringify({ vaultPath: tmpVault }),
  })).status).toBe(200);

  expect((await app.request("/knowledge/obsidian/stop", {
    method: "POST", headers: adminH, body: JSON.stringify({}),
  })).status).toBe(200);

  expect((await app.request("/mcp/install", {
    method: "POST", headers: adminH, body: JSON.stringify({ client: "bogus" }),
  })).status).toBe(400);

  expect((await app.request("/ingest/sessions", {
    method: "POST", headers: adminH, body: JSON.stringify({ sinceDays: 0 }),
  })).status).toBe(200);

  expect((await app.request("/system/logs", { headers: adminH })).status).toBe(200);

  expect((await app.request("/actors", {
    method: "POST", headers: adminH, body: JSON.stringify({ name: uniq("authz-minted"), kind: "agent" }),
  })).status).toBe(201);

  const memberChecks: [string, RequestInit][] = [
    [`/settings/${settingsKey}`, { headers: memberH }],
    [`/settings/${settingsKey}`, { method: "PATCH", headers: memberH, body: JSON.stringify({ value: "x" }) }],
    ["/knowledge/obsidian/start", { method: "POST", headers: memberH, body: JSON.stringify({}) }],
    ["/knowledge/obsidian/stop", { method: "POST", headers: memberH, body: JSON.stringify({}) }],
    ["/mcp/install", { method: "POST", headers: memberH, body: JSON.stringify({ client: "bogus" }) }],
    ["/ingest/sessions", { method: "POST", headers: memberH, body: JSON.stringify({ sinceDays: 0 }) }],
    ["/system/logs", { headers: memberH }],
    ["/actors", { method: "POST", headers: memberH, body: JSON.stringify({ name: uniq("authz-nope"), kind: "agent" }) }],
    ["/forge/agents", { headers: memberH }],
    ["/forge/doctor", { headers: memberH }],
    ["/forge/pipeline", { method: "POST", headers: memberH, body: JSON.stringify({}) }],
    ["/forge/runs", { headers: memberH }],
    ["/forge/tickets/00000000-0000-0000-0000-000000000000/resume", { method: "POST", headers: memberH }],
    ["/forge/tickets/00000000-0000-0000-0000-000000000000/promote", { method: "POST", headers: memberH }],
    ["/forge/tickets/00000000-0000-0000-0000-000000000000/approve", { method: "POST", headers: memberH }],
    ["/tickets/00000000-0000-0000-0000-000000000000/verify", { method: "POST", headers: memberH }],
    ["/council/evaluate", { method: "POST", headers: memberH, body: JSON.stringify({ prompt: "long enough prompt" }) }],
    ["/council/00000000-0000-0000-0000-000000000000/create-ticket", { method: "POST", headers: memberH, body: JSON.stringify({ projectId: "x" }) }],
    ["/skills/marketplaces", { headers: memberH }],
    ["/skills/marketplaces", { method: "POST", headers: memberH, body: JSON.stringify({ url: "https://example.com/repo.git" }) }],
    ["/skills/marketplaces", { method: "DELETE", headers: memberH, body: JSON.stringify({ url: "https://example.com/repo.git" }) }],
    ["/skills/install", { method: "POST", headers: memberH, body: JSON.stringify({ url: "https://example.com/repo.git", dir: "x" }) }],
    ["/skills/uninstall", { method: "POST", headers: memberH, body: JSON.stringify({ name: "x" }) }],
    ["/skills/installed", { headers: memberH }],
    ["/projects/00000000-0000-0000-0000-000000000000", { method: "PATCH", headers: memberH, body: JSON.stringify({ repoPath: "" }) }],
    ["/projects/00000000-0000-0000-0000-000000000000/git-init", { method: "POST", headers: memberH }],
    ["/projects/00000000-0000-0000-0000-000000000000/settings", { headers: memberH }],
    ["/projects/00000000-0000-0000-0000-000000000000/settings/github.repo", { method: "PUT", headers: memberH, body: JSON.stringify({ value: "x" }) }],
  ];
  for (const [path, init] of memberChecks) {
    const res = await app.request(path, init);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  }
});

test("member work surface stays intact", async () => {
  const { apiKey } = await createActor({ name: uniq("authz-worker"), kind: "human" });
  const h = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  const proj = await (await app.request("/projects", {
    method: "POST", headers: h, body: JSON.stringify({ key: uniq("authz-proj"), name: "Authz Proj" }),
  })).json();

  const ticket = await app.request("/tickets", {
    method: "POST", headers: h, body: JSON.stringify({ projectId: proj.id, title: "member can still work" }),
  });
  expect(ticket.status).toBe(201);

  expect((await app.request("/knowledge?q=x", { headers: h })).status).toBe(200);

  const note = await app.request("/notes", {
    method: "POST", headers: h, body: JSON.stringify({ body: "hi", scope: "global", title: "n" }),
  });
  expect(note.status).toBe(201);
});

test("POST /actors: mints keys, defaults role member, validates input", async () => {
  const { apiKey: adminKey } = await createActor({ name: uniq("authz-minter"), kind: "human", role: "admin" });
  const adminH = { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" };

  const res = await app.request("/actors", {
    method: "POST", headers: adminH, body: JSON.stringify({ name: uniq("authz-minted-member"), kind: "agent" }),
  });
  expect(res.status).toBe(201);
  const { actor, apiKey } = await res.json();
  expect(actor.role).toBe("member");
  expect(apiKey).toMatch(/^[0-9a-f]{48}$/);

  const mintedH = { Authorization: `Bearer ${apiKey}` };
  expect((await app.request("/projects", { headers: mintedH })).status).toBe(200);
  expect((await app.request("/system/logs", { headers: mintedH })).status).toBe(403);

  const badRole = await app.request("/actors", {
    method: "POST", headers: adminH, body: JSON.stringify({ name: uniq("authz-bad-role"), kind: "agent", role: "bogus" }),
  });
  expect(badRole.status).toBe(400);

  const adminMinted = await app.request("/actors", {
    method: "POST", headers: adminH, body: JSON.stringify({ name: uniq("authz-minted-admin"), kind: "agent", role: "admin" }),
  });
  expect(adminMinted.status).toBe(201);
  expect((await adminMinted.json()).actor.role).toBe("admin");
});

test("guarded routes require auth: 401 beats 403", async () => {
  expect((await app.request("/settings/authz-noauth")).status).toBe(401);
  expect((await app.request("/system/logs")).status).toBe(401);
  expect((await app.request("/actors", {
    method: "POST", body: JSON.stringify({ name: "x", kind: "agent" }),
  })).status).toBe(401);
});

test("verification comments and council export are admin-only surfaces", async () => {
  const { apiKey: adminKey, actor: admin } = await createActor({ name: uniq("authz-ver-admin"), kind: "human", role: "admin" });
  const { apiKey: memberKey } = await createActor({ name: uniq("authz-ver-member"), kind: "agent" });
  const adminH = { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" };
  const memberH = { Authorization: `Bearer ${memberKey}`, "Content-Type": "application/json" };

  const project = await createProject({ key: uniq("authz-ver"), name: "Authz verification" });
  const ticket = await createTicket(admin.id, { projectId: project.id, title: "authz verification target" });

  const memberPost = await app.request(`/tickets/${ticket.id}/comments`, {
    method: "POST", headers: memberH, body: JSON.stringify({ body: "VERIFICATION: PASS", kind: "verification" }),
  });
  expect(memberPost.status).toBe(403);

  const adminPost = await app.request(`/tickets/${ticket.id}/comments`, {
    method: "POST", headers: adminH, body: JSON.stringify({ body: "VERIFICATION: PASS", kind: "verification" }),
  });
  expect(adminPost.status).toBe(201);

  // council export must not widen the admin-only council read surface
  const memberExport = await app.request(`/export/brief?kind=council&id=${uniq("cid")}`, { headers: memberH });
  expect(memberExport.status).toBe(403);
});
