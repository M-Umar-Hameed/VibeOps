import { describe, it, expect, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { app } from "../src/api/app.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import * as store from "../src/chat/store.js";
import { setChatAgent, runTurn } from "../src/chat/turns.js";
import { searchKnowledge } from "../src/services/knowledge.js";
import { db } from "../src/db/client.js";
import { embeddings } from "../src/db/schema.js";

process.env.EMBED_PROVIDER = "fake";

function uniq(p: string) { return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`; }

async function adminHeaders(): Promise<Record<string, string>> {
  const { apiKey } = await createActor({ name: uniq("chat-del-admin"), kind: "human", role: "admin" });
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function chunkCount(ref: string) {
  const rows = await db.select({ id: embeddings.id }).from(embeddings)
    .where(and(eq(embeddings.sourceKind, "chat"), eq(embeddings.sourceRef, ref)));
  return rows.length;
}

async function chunk0(ref: string) {
  const [row] = await db.select({ content: embeddings.content }).from(embeddings)
    .where(and(eq(embeddings.sourceKind, "chat"), eq(embeddings.sourceRef, ref), eq(embeddings.chunkIndex, 0)));
  return row.content;
}

describe("DELETE /chat/sessions/:id", () => {
  afterEach(() => {
    setChatAgent(async () => ({ ok: true, text: "default" }));
  });

  it("removes the session and its messages; follow-up GET is 404", async () => {
    const h = await adminHeaders();
    const create = await app.request("/chat/sessions", {
      method: "POST", headers: h, body: JSON.stringify({ title: "to delete" }),
    });
    const { id } = await create.json();
    await store.appendMessage({ sessionId: id, role: "user", body: "hello" });

    const del = await app.request(`/chat/sessions/${id}`, { method: "DELETE", headers: h });
    expect(del.status).toBe(200);

    const get = await app.request(`/chat/sessions/${id}`, { headers: h });
    expect(get.status).toBe(404);
    expect(await store.getMessages(id)).toHaveLength(0);
  });

  it("removes indexed chunks for a GLOBAL (bare-id) session", async () => {
    process.env.EMBED_PROVIDER = "fake";
    const h = await adminHeaders();
    const { actor } = await createActor({ name: uniq("chat-del-g"), kind: "human" });
    const marker = uniq("GLOBALMARK");
    const sess = await store.createSession("global delete"); // projectId null => bare ref
    setChatAgent(async () => ({ ok: true, text: `reply ${marker}`, sessionId: "sdk-g" }));
    await runTurn(actor, sess.id, `ask ${marker}`);

    const ref = sess.id;
    expect(await chunkCount(ref)).toBeGreaterThan(0);
    const content = await chunk0(ref);
    const before = await searchKnowledge(content, { limit: 20 });
    expect(before.some((hh) => hh.sourceRef === ref && hh.sourceKind === "chat")).toBe(true);

    const del = await app.request(`/chat/sessions/${sess.id}`, { method: "DELETE", headers: h });
    expect(del.status).toBe(200);

    expect(await chunkCount(ref)).toBe(0);
    const after = await searchKnowledge(content, { limit: 20 });
    expect(after.some((hh) => hh.sourceRef === ref && hh.sourceKind === "chat")).toBe(false);
  });

  it("removes indexed chunks for a PROJECT-scoped (<projectId>:<id>) session", async () => {
    process.env.EMBED_PROVIDER = "fake";
    const h = await adminHeaders();
    const { actor } = await createActor({ name: uniq("chat-del-p"), kind: "human" });
    const proj = await createProject({ key: uniq("chatdel").toLowerCase(), name: "chat del proj" });
    const marker = uniq("PROJMARK");
    const sess = await store.createSession("project delete", "sonnet", proj.id);
    setChatAgent(async () => ({ ok: true, text: `reply ${marker}`, sessionId: "sdk-p" }));
    await runTurn(actor, sess.id, `ask ${marker}`);

    const ref = `${proj.id}:${sess.id}`;
    expect(await chunkCount(ref)).toBeGreaterThan(0);
    const content = await chunk0(ref);
    const before = await searchKnowledge(content, { limit: 20 });
    expect(before.some((hh) => hh.sourceRef === ref && hh.sourceKind === "chat")).toBe(true);

    const del = await app.request(`/chat/sessions/${sess.id}`, { method: "DELETE", headers: h });
    expect(del.status).toBe(200);

    expect(await chunkCount(ref)).toBe(0);
    const after = await searchKnowledge(content, { limit: 20 });
    expect(after.some((hh) => hh.sourceRef === ref && hh.sourceKind === "chat")).toBe(false);
  });

  it("returns 409 and does not delete while a turn is in flight", async () => {
    const h = await adminHeaders();
    const create = await app.request("/chat/sessions", {
      method: "POST", headers: h, body: JSON.stringify({ title: "busy" }),
    });
    const { id } = await create.json();

    let resolveFirst!: () => void;
    const block = new Promise<void>((r) => { resolveFirst = r; });
    setChatAgent(async () => { await block; return { ok: true, text: "done" }; });

    // Fire-and-forget turn; wait for it to register as running.
    await app.request(`/chat/sessions/${id}/messages`, {
      method: "POST", headers: h, body: JSON.stringify({ body: "first" }),
    });
    await new Promise((r) => setTimeout(r, 50));

    const del = await app.request(`/chat/sessions/${id}`, { method: "DELETE", headers: h });
    expect(del.status).toBe(409);
    expect((await del.json()).error).toContain("already running");

    // Session still there.
    const get = await app.request(`/chat/sessions/${id}`, { headers: h });
    expect(get.status).toBe(200);

    // Cleanup: unblock and drain to idle so the background turn can't leak into other files.
    resolveFirst();
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const out = await app.request(`/chat/sessions/${id}/output?after=0`, { headers: h });
      if ((await out.json()).status === "idle") break;
    }
  });
});
