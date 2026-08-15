import type { Hono } from "hono";
import type { Actor } from "../db/schema.js";
import { requireAdmin } from "./auth.js";
import * as store from "../chat/store.js";
import { isRunning, runTurn, getChatOutput } from "../chat/turns.js";

type AppEnv = { Variables: { actor: Actor } };

export function registerChatRoutes(app: Hono<AppEnv>): void {
  app.post("/chat/sessions", requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const title = typeof body.title === "string" ? body.title : undefined;
    const model = body.model === "opus" ? "opus" : "sonnet";
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
    const model = body.model === "opus" || body.model === "sonnet" ? body.model : undefined;
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
}
