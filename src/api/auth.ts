import { createMiddleware } from "hono/factory";
import { resolveActor } from "../services/actors.js";
import { AuthError, ForbiddenError } from "../services/errors.js";
import type { Actor } from "../db/schema.js";

export const auth = createMiddleware<{ Variables: { actor: Actor } }>(async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const key = header.replace(/^Bearer\s+/i, "");
  try {
    c.set("actor", await resolveActor(key));
  } catch {
    throw new AuthError("unauthorized");
  }
  await next();
});

// Admin-only gate for routes that touch host state (settings, filesystem
// indexing, config writes, key minting). Runs after `auth`, so a bad key is
// 401 before role is ever considered.
export const requireAdmin = createMiddleware<{ Variables: { actor: Actor } }>(async (c, next) => {
  if (c.get("actor").role !== "admin") throw new ForbiddenError("forbidden");
  await next();
});
