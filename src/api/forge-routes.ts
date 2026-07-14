import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { Actor } from "../db/schema.js";
import { loadRelayConfig } from "../relay/config.js";
import { parseVerdict } from "../relay/prompts.js";
import { startPipeline, listRuns, getRunOutput, stopRun } from "../forge/runs.js";
import {
  sandboxExists, branchName, sandboxDiff, promoteSandbox, discardSandbox,
} from "../forge/sandbox.js";
import { updateTicket } from "../services/tickets.js";
import { getTicket } from "../services/history.js";
import { addComment, listComments } from "../services/comments.js";
import { ConflictError, NotFoundError } from "../services/errors.js";
import { requireAdmin } from "./auth.js";

type AppEnv = { Variables: { actor: Actor } };

function forgeConfig() {
  return loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG);
}

function listSkillDir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

async function lastVerdict(ticketId: string): Promise<"pass" | "fail" | null> {
  const review = [...(await listComments(ticketId))].reverse().find((c) => c.kind === "review");
  if (!review) return null;
  return parseVerdict(review.body).pass ? "pass" : "fail";
}

export function registerForgeRoutes(app: Hono<AppEnv>): void {
  app.get("/forge/agents", requireAdmin, async (c) => {
    const config = forgeConfig();
    return c.json(Object.entries(config.agents).map(([name, a]) => ({ name, roles: a.roles })));
  });

  app.get("/forge/skills", requireAdmin, async (c) => {
    const config = forgeConfig();
    const names = new Set([
      ...listSkillDir(join(homedir(), ".claude", "skills")),
      ...listSkillDir(join(config.workdir, ".claude", "skills")),
    ]);
    return c.json([...names].map((name) => ({ name })));
  });

  app.post("/forge/pipeline", requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { ticketId, planAgent, workAgent, reviewAgent, extraPrompt } = body;
    if (typeof ticketId !== "string" || !ticketId) return c.json({ error: "ticketId required" }, 400);
    if (typeof planAgent !== "string" || !planAgent) return c.json({ error: "planAgent required" }, 400);
    if (typeof workAgent !== "string" || !workAgent) return c.json({ error: "workAgent required" }, 400);
    if (typeof reviewAgent !== "string" || !reviewAgent) return c.json({ error: "reviewAgent required" }, 400);
    if (extraPrompt !== undefined && typeof extraPrompt !== "string") {
      return c.json({ error: "extraPrompt must be a string" }, 400);
    }

    try {
      const { runId } = await startPipeline(c.get("actor").id, forgeConfig(), {
        ticketId, planAgent, workAgent, reviewAgent, extraPrompt,
      });
      return c.json({ runId }, 201);
    } catch (e) {
      if (e instanceof ConflictError || e instanceof NotFoundError) throw e;
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.get("/forge/runs", requireAdmin, async (c) => c.json(listRuns()));

  app.get("/forge/runs/:id/output", requireAdmin, async (c) => {
    const after = Number(c.req.query("after")) || 0;
    const out = getRunOutput(c.req.param("id"), after);
    if (!out) return c.json({ error: "run not found" }, 404);
    return c.json(out);
  });

  app.post("/forge/runs/:id/stop", requireAdmin, async (c) =>
    c.json({ stopped: stopRun(c.req.param("id")) }));

  app.get("/forge/tickets/:id/sandbox", requireAdmin, async (c) => {
    const ticketId = c.req.param("id");
    return c.json({
      exists: sandboxExists(ticketId),
      branch: branchName(ticketId),
      lastVerdict: await lastVerdict(ticketId),
    });
  });

  app.get("/forge/tickets/:id/diff", requireAdmin, async (c) => {
    const ticketId = c.req.param("id");
    if (!sandboxExists(ticketId)) return c.json({ error: "no sandbox for ticket" }, 404);
    const diff = await sandboxDiff(forgeConfig().workdir, ticketId);
    return c.json({ diff });
  });

  app.post("/forge/tickets/:id/promote", requireAdmin, async (c) => {
    const ticketId = c.req.param("id");
    const verdict = await lastVerdict(ticketId);
    if (!sandboxExists(ticketId) || verdict !== "pass") {
      return c.json({ error: "sandbox must exist and have a passing review before promoting" }, 409);
    }
    await promoteSandbox(forgeConfig().workdir, ticketId);
    await addComment(c.get("actor").id, ticketId, "forge: promoted", "comment");
    const fresh = await getTicket(ticketId);
    const updated = await updateTicket(c.get("actor").id, ticketId, fresh.version, { status: "closed" });
    return c.json(updated);
  });

  app.post("/forge/tickets/:id/discard", requireAdmin, async (c) => {
    const ticketId = c.req.param("id");
    if (!sandboxExists(ticketId)) return c.json({ error: "no sandbox for ticket" }, 404);
    await discardSandbox(forgeConfig().workdir, ticketId);
    await addComment(c.get("actor").id, ticketId, "forge: sandbox discarded", "comment");
    let ticket = await getTicket(ticketId);
    if (ticket.status === "review") {
      ticket = await updateTicket(c.get("actor").id, ticketId, ticket.version, { status: "planned" });
    }
    return c.json(ticket);
  });
}
