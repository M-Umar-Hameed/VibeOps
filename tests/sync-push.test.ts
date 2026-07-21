import { expect, test, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { projects, syncLinks } from "../src/db/schema.js";
import { createActor } from "../src/services/actors.js";
import { setSetting } from "../src/services/settings.js";
import { createTicket } from "../src/services/tickets.js";
import { pushGithub } from "../src/sync/push.js";

function uniq(p: string) { return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`; }

async function actorId() { const { actor } = await createActor({ name: uniq("push"), kind: "agent" }); return actor.id; }
async function project() { const [p] = await db.insert(projects).values({ key: uniq("proj"), name: "P" }).returning(); return p.id; }

function makeFetch(responses: any[]) {
  let i = 0;
  return vi.fn(async (url: string, opts?: any) => {
    const r = responses[i++];
    if (!r) throw new Error(`Unexpected fetch call to ${url}`);
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.data };
  });
}

afterEach(() => vi.unstubAllGlobals());

test("1. Create a local-only ticket -> pushes to github and creates link", async () => {
  const aid = await actorId();
  const projectId = await project();
  const repo = `${uniq("owner")}/repo`;
  await setSetting("github.token", "t");
  
  const ticket = await createTicket(aid, { projectId, title: "Local", body: "lb", status: "open" });
  
  const stub = makeFetch([
    { data: { number: 42, updated_at: "2026-01-01T00:00:00Z" } }
  ]);
  
  const result = await pushGithub(stub as any, { projectId, binding: repo });
  expect(stub).toHaveBeenCalledTimes(1);
  const call = stub.mock.calls[0];
  expect(call[0]).toContain("/issues");
  expect(call[1].method).toBe("POST");
  expect(JSON.parse(call[1].body)).toEqual({ title: "Local", body: "lb" });
  expect(result.pushed).toBe(1);
  
  const links = await db.select().from(syncLinks).where(eq(syncLinks.ticketId, ticket.id));
  expect(links).toHaveLength(1);
  expect(links[0].source).toBe("github");
  expect(links[0].externalId).toBe(`${repo}#42`);
});

test("2. Closed local ticket, github issue open -> PATCH closed", async () => {
  const aid = await actorId();
  const projectId = await project();
  const repo = `${uniq("owner")}/repo`;
  await setSetting("github.token", "t");

  const ticket = await createTicket(aid, { projectId, title: "done", body: "", status: "closed" });
  await db.insert(syncLinks).values({
    source: "github",
    externalId: `${repo}#7`,
    ticketId: ticket.id,
    externalUpdatedAt: new Date()
  });

  const stub = makeFetch([
    { data: { state: "open" } },
    { data: {} }
  ]);

  const result = await pushGithub(stub as any, { projectId, binding: repo });
  expect(stub).toHaveBeenCalledTimes(2);
  const call = stub.mock.calls[1];
  expect(call[0]).toContain("/issues/7");
  expect(call[1].method).toBe("PATCH");
  expect(JSON.parse(call[1].body)).toEqual({ state: "closed" });
  expect(result.closed).toBe(1);
});

test("3. Pulled ticket never re-pushed", async () => {
  const aid = await actorId();
  const projectId = await project();
  const repo = `${uniq("owner")}/repo`;
  await setSetting("github.token", "t");

  const ticket = await createTicket(aid, { projectId, title: "open", body: "", status: "open" });
  await db.insert(syncLinks).values({
    source: "github",
    externalId: `${repo}#8`,
    ticketId: ticket.id,
    externalUpdatedAt: new Date()
  });

  const stub = vi.fn();
  const result = await pushGithub(stub as any, { projectId, binding: repo });
  expect(stub).not.toHaveBeenCalled();
  expect(result.pushed).toBe(0);
  expect(result.closed).toBe(0);
});

test("4. Second run idempotent (no duplicate POST)", async () => {
  const aid = await actorId();
  const projectId = await project();
  const repo = `${uniq("owner")}/repo`;
  await setSetting("github.token", "t");
  
  const ticket = await createTicket(aid, { projectId, title: "Local", body: "lb", status: "open" });
  
  const stub1 = makeFetch([
    { data: { number: 42, updated_at: "2026-01-01T00:00:00Z" } }
  ]);
  
  await pushGithub(stub1 as any, { projectId, binding: repo });
  
  const stub2 = vi.fn(async () => { throw new Error("Should not be called"); });
  await pushGithub(stub2 as any, { projectId, binding: repo });
  
  expect(stub2).not.toHaveBeenCalled();
  
  const links = await db.select().from(syncLinks).where(eq(syncLinks.ticketId, ticket.id));
  expect(links).toHaveLength(1);
});

test("5. Cross-source ticket not pushed to github", async () => {
  const aid = await actorId();
  const projectId = await project();
  const repo = `${uniq("owner")}/repo`;
  await setSetting("github.token", "t");

  const ticket = await createTicket(aid, { projectId, title: "open", body: "", status: "open" });
  await db.insert(syncLinks).values({
    source: "gitlab",
    externalId: `${uniq("gitlab-proj")}#8`,
    ticketId: ticket.id,
    externalUpdatedAt: new Date()
  });

  const stub = vi.fn();
  const result = await pushGithub(stub as any, { projectId, binding: repo });
  expect(stub).not.toHaveBeenCalled();
  expect(result.pushed).toBe(0);
});

test("6. Rate limit stops push", async () => {
  const aid = await actorId();
  const projectId = await project();
  const repo = `${uniq("owner")}/repo`;
  await setSetting("github.token", "t");
  
  await createTicket(aid, { projectId, title: "T1", status: "open" });
  await createTicket(aid, { projectId, title: "T2", status: "open" });
  
  const stub = makeFetch([
    { status: 429 }
  ]);
  
  const result = await pushGithub(stub as any, { projectId, binding: repo });
  expect(stub).toHaveBeenCalledTimes(1);
  expect(result.pushed).toBe(0);
});

test("7. Closed issue already closed -> no PATCH", async () => {
  const aid = await actorId();
  const projectId = await project();
  const repo = `${uniq("owner")}/repo`;
  await setSetting("github.token", "t");

  const ticket = await createTicket(aid, { projectId, title: "done", body: "", status: "closed" });
  await db.insert(syncLinks).values({
    source: "github",
    externalId: `${repo}#7`,
    ticketId: ticket.id,
    externalUpdatedAt: new Date()
  });

  const stub = makeFetch([
    { data: { state: "closed" } }
  ]);

  const result = await pushGithub(stub as any, { projectId, binding: repo });
  expect(stub).toHaveBeenCalledTimes(1);
  expect(result.closed).toBe(0);
});
