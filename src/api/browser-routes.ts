import type { Hono } from "hono";
import type { Actor } from "../db/schema.js";
import { register, list, exists, nextBatch, submitResult, submitBatch, type BatchResult } from "../browser/channel.js";
import { validateSteps } from "../browser/validate.js";
import { hasActGrant, noActGrantReason, addActGrant } from "../browser/grants.js";
import { requireAdmin } from "./auth.js";

const MUTATING = new Set(["click", "type", "select", "press", "navigate", "clickAt"]);

type AppEnv = { Variables: { actor: Actor } };

// Member-auth (global `auth` only, no requireAdmin) — same trust level as the
// ticket/notes work surface. Transport is HTTP long-poll on this same server;
// see channel.ts for the WebSocket upgrade path.
export function registerBrowserRoutes(app: Hono<AppEnv>): void {
  // Admin-only, like every host-touching route (settings sit behind requireAdmin in
  // app.ts). Appends one { origin, mode:"act" } to browserGrants. The origin is the
  // one the caller was refused; hasActGrant's exact match keeps this scoped to it.
  app.post("/browser/grants", requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => null);
    const b = (body ?? {}) as { origin?: unknown };
    if (typeof b.origin !== "string" || !b.origin.trim()) {
      return c.json({ error: "origin required" }, 400);
    }
    await addActGrant(b.origin);
    return c.json({ ok: true });
  });

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
    const { instanceId, tenant, steps, targetOrigin } = (body ?? {}) as { instanceId?: unknown; tenant?: unknown; steps?: unknown; targetOrigin?: unknown };
    if (typeof instanceId !== "string" || !exists(instanceId)) return c.json({ error: "unknown instance" }, 404);
    if (typeof tenant !== "string" || !tenant.trim()) return c.json({ error: "tenant required" }, 400);
    const v = validateSteps(steps);
    if (!v.ok) return c.json({ error: v.error }, 400);
    // Server is the grant authority. A client-supplied `grant` field is never read
    // here (stripped); mutating batches require a server-verified act grant, and the
    // delivered grant/targetOrigin are set only from that verified decision.
    let delivery: { grant: "act"; targetOrigin: string } | undefined;
    if (v.steps.some((s) => MUTATING.has(s.verb))) {
      if (typeof targetOrigin !== "string" || !targetOrigin.trim()) {
        return c.json({ error: "targetOrigin required for a mutating batch" }, 400);
      }
      if (!(await hasActGrant(targetOrigin))) {
        return c.json({ error: noActGrantReason(targetOrigin) }, 403);
      }
      delivery = { grant: "act", targetOrigin };
    }
    const result = await submitBatch(instanceId, tenant, v.steps, delivery);
    if (!result) return c.json({ error: "batch timed out" }, 504);
    return c.json(result);
  });
}
