import type { Hono } from "hono";
import { loadRelayConfig } from "../relay/config.js";
import { requireAdmin } from "./auth.js";
import { startCouncil, submitAnswers, createTicketFromCouncil, getCouncil, getCouncilOutput } from "../council/runs.js";
import { ConflictError, NotFoundError } from "../services/errors.js";
import type { Actor } from "../db/schema.js";

type AppEnv = { Variables: { actor: Actor } };

function config() {
  return loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG);
}

export function registerCouncilRoutes(app: Hono<AppEnv>): void {
  app.post("/council/evaluate", requireAdmin, async (c) => {
    const { prompt, projectId } = await c.req.json().catch(() => ({}));
    if (!prompt || typeof prompt !== "string") return c.json({ error: "prompt string required" }, 400);
    try {
      const res = await startCouncil(c.get("actor").id, config(), { prompt, projectId });
      return c.json(res, 201);
    } catch (e: any) {
      if (e instanceof ConflictError || e instanceof NotFoundError) throw e;
      return c.json({ error: e.message }, 400);
    }
  });

  app.get("/council/:id", requireAdmin, async (c) => {
    try {
      return c.json(getCouncil(c.req.param("id")));
    } catch (e: any) {
      return c.json({ error: e.message }, 404);
    }
  });

  app.get("/council/:id/output", requireAdmin, async (c) => {
    const after = Number(c.req.query("after")) || 0;
    const out = getCouncilOutput(c.req.param("id"), after);
    if (!out) return c.json({ error: "not found" }, 404);
    return c.json(out);
  });

  app.post("/council/:id/answers", requireAdmin, async (c) => {
    const { answers } = await c.req.json().catch(() => ({}));
    if (!Array.isArray(answers)) return c.json({ error: "answers array required" }, 400);
    try {
      await submitAnswers(c.req.param("id"), config(), answers);
      return c.json({ ok: true });
    } catch (e: any) {
      if (e instanceof ConflictError || e instanceof NotFoundError) throw e;
      return c.json({ error: e.message }, 400);
    }
  });

  app.post("/council/:id/create-ticket", requireAdmin, async (c) => {
    const { projectId, force } = await c.req.json().catch(() => ({}));
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    try {
      const ticket = await createTicketFromCouncil(c.get("actor").id, c.req.param("id"), projectId, !!force);
      return c.json(ticket, 201);
    } catch (e: any) {
      if (e instanceof ConflictError || e instanceof NotFoundError) throw e;
      return c.json({ error: e.message }, 400);
    }
  });
}
