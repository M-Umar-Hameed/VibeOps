import { createMiddleware } from "hono/factory";
import { resolveActor } from "../services/actors.js";
import { AuthError } from "../services/errors.js";
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
