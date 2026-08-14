import type { Hono } from "hono";
import type { Actor } from "../db/schema.js";
import { register, list, exists, nextBatch, submitResult, submitBatch, type BatchResult } from "../browser/channel.js";
import { validateSteps } from "../browser/validate.js";

type AppEnv = { Variables: { actor: Actor } };

// Member-auth (global `auth` only, no requireAdmin) — same trust level as the
// ticket/notes work surface. Transport is HTTP long-poll on this same server;
// see channel.ts for the WebSocket upgrade path.
export function registerBrowserRoutes(app: Hono<AppEnv>): void {
  app.post("/browser/instances/register", async (c) => {
    const body = await c.req.json().catch(() => null);
    const { browserChannel, profileId, profileLabel } = (body ?? {}) as Record<string, unknown>;
    if (typeof browserChannel !== "string" || typeof profileId !== "string" || typeof profileLabel !== "string") {
      return c.json({ error: "browserChannel, profileId, profileLabel required" }, 400);
    }
    return c.json({ instanceId: register({ browserChannel, profileId, profileLabel }) }, 201);
  });

  app.get("/browser/instances", (c) => c.json(list()));

  app.get("/browser/poll", async (c) => {
    const instanceId = c.req.query("instanceId") ?? "";
    if (!exists(instanceId)) return c.json({ error: "unknown instance" }, 404);
    const batch = await nextBatch(instanceId);
    if (!batch) return c.body(null, 204);
    return c.json(batch);
  });

  app.post("/browser/results", async (c) => {
    const body = await c.req.json().catch(() => null);
    const { batchId, result } = (body ?? {}) as { batchId?: unknown; result?: unknown };
    if (typeof batchId !== "string") return c.json({ error: "batchId required" }, 400);
    if (typeof result !== "object" || result === null) return c.json({ error: "result required" }, 400);
    // result is untrusted page-derived data: matched to its waiter and returned
    // verbatim to the /browser/batches caller, never interpolated server-side.
    return submitResult(batchId, result as BatchResult)
      ? c.json({ ok: true })
      : c.json({ error: "unknown or expired batch" }, 404);
  });

  app.post("/browser/batches", async (c) => {
    const body = await c.req.json().catch(() => null);
    const { instanceId, tenant, steps } = (body ?? {}) as { instanceId?: unknown; tenant?: unknown; steps?: unknown };
    if (typeof instanceId !== "string" || !exists(instanceId)) return c.json({ error: "unknown instance" }, 404);
    if (typeof tenant !== "string" || !tenant.trim()) return c.json({ error: "tenant required" }, 400);
    const v = validateSteps(steps);
    if (!v.ok) return c.json({ error: v.error }, 400);
    const result = await submitBatch(instanceId, tenant, v.steps);
    if (!result) return c.json({ error: "batch timed out" }, 504);
    return c.json(result);
  });
}
