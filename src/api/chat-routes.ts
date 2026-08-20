import type { Hono } from "hono";
import type { Actor } from "../db/schema.js";
import { requireAdmin } from "./auth.js";
import * as store from "../chat/store.js";
import { isRunning, runTurn, getChatOutput } from "../chat/turns.js";
import { loadRelayConfig } from "../relay/config.js";
import { buildRoster } from "../chat/roster.js";
import { deleteChatDoc } from "../services/knowledge.js";

type AppEnv = { Variables: { actor: Actor } };

export function registerChatRoutes(app: Hono<AppEnv>): void {
  app.get("/chat/models", requireAdmin, (c) => {
    try {
      return c.json(buildRoster(loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG)));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  app.post("/chat/sessions", requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const title = typeof body.title === "string" ? body.title : undefined;
    const model = typeof body.model === "string" && body.model ? body.model : "sonnet";
    const projectId = typeof body.projectId === "string" ? body.projectId : null;
    return c.json(await store.createSession(title, model, projectId), 201);
  });

  app.get("/chat/sessions", requireAdmin, async (c) => {
    return c.json(await store.listSessions());
  });

  app.get("/chat/sessions/:id", requireAdmin, async (c) => {
    const s = await store.getSession(c.req.param("id"));
    if (!s) return c.json({ error: "session not found" }, 404);
    return c.json({ session: s, messages: await store.getMessages(s.id) });
  });

  app.post("/chat/sessions/:id/messages", requireAdmin, async (c) => {
    const id = c.req.param("id");
    if (!(await store.getSession(id))) {
      return c.json({ error: "session not found" }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.body !== "string" || !body.body.trim()) {
      return c.json({ error: "body required" }, 400);
    }
    const model = typeof body.model === "string" && body.model ? body.model : undefined;
    if (isRunning(id)) {
      return c.json({ error: "a turn is already running for this session" }, 409);
    }
    // Fire-and-forget; polled via /output
    runTurn(c.get("actor"), id, body.body, model).catch(() => {});
    return c.json({ ok: true }, 202);
  });

  app.get("/chat/sessions/:id/output", requireAdmin, async (c) => {
    const after = Number(c.req.query("after")) || 0;
    return c.json(getChatOutput(c.req.param("id"), after));
  });

  app.delete("/chat/sessions/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const session = await store.getSession(id);
    if (!session) {
      return c.json({ error: "session not found" }, 404);
    }
    // Chat is one-turn-at-a-time; never delete out from under a running agent.
    if (isRunning(id)) {
      return c.json({ error: "a turn is already running for this session" }, 409);
    }
    // Ref mirrors src/chat/turns.ts: "<projectId>:<id>" project-scoped, bare "<id>" global.
    // Chunks first, then rows: a mid-failure leaves chunks already gone (deleteChatDoc is
    // idempotent), never an orphaned transcript still searchable after the session is gone.
    const ref = session.projectId ? `${session.projectId}:${id}` : id;
    await deleteChatDoc(ref);
    await store.deleteSession(id);
    return c.json({ ok: true });
  });

  app.patch("/chat/sessions/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    if (!(await store.getSession(id))) {
      return c.json({ error: "session not found" }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
      return c.json({ error: "title required" }, 400);
    }
    return c.json(await store.renameSession(id, title));
  });
}
