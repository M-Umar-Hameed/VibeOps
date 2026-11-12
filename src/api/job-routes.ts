import type { Context, Hono } from "hono";
import { requireAdmin } from "./auth.js";
import { getJob, listJobs, cancelJob, type Started } from "../services/jobs.js";
import type { Actor } from "../db/schema.js";

// Default: wait and return the result (old synchronous shape kept for scripts/MCP).
// ?async=1: 202 { jobId, existing } now; poll GET /jobs/:id.
export async function respondWithJob<T>(c: Context, started: Started<T>) {
  if (c.req.query("async") === "1") return c.json({ jobId: started.job.id, existing: started.existing }, 202);
  if (started.existing) return c.json({ error: `${started.job.label} already running`, jobId: started.job.id }, 409);
  c.header("X-Job-Id", started.job.id);
  return c.json((await started.promise) as any);
}

export function registerJobRoutes(app: Hono<{ Variables: { actor: Actor } }>) {
  app.get("/jobs", requireAdmin, (c) => c.json(listJobs({ kind: c.req.query("kind") || undefined, active: c.req.query("active") === "1" })));
  app.get("/jobs/:id", requireAdmin, (c) => {
    const j = getJob(c.req.param("id"));
    return j ? c.json(j) : c.json({ error: "job not found" }, 404);
  });
  app.post("/jobs/:id/cancel", requireAdmin, (c) => {
    const j = getJob(c.req.param("id"));
    if (!j) return c.json({ error: "job not found" }, 404);
    if (!cancelJob(j.id)) return c.json({ error: "job is not cancellable or already finished" }, 409);
    return c.json(j);
  });
}
