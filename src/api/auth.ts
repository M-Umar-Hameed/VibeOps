import { createHash } from "node:crypto";
import { createMiddleware } from "hono/factory";
import { resolveActor } from "../services/actors.js";
import { AuthError, ForbiddenError } from "../services/errors.js";
import type { Actor } from "../db/schema.js";

const failures = new Map<string, { count: number; until: number }>();
// ponytail: in-memory throttle, 20 failures/min per presented key; per-IP
// buckets if this ever fronts untrusted networks.
const MAX_FAILURES = 20;
const WINDOW_MS = 60_000;
const MAX_BUCKETS = 10_000;

// Full-key hash as the bucket: prefixes can collide across a key scheme and
// lock out sibling keys.
function bucketOf(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function purgeExpired(now: number): void {
  // Lazy sweep bounds the map against attackers cycling invalid keys.
  if (failures.size < MAX_BUCKETS) return;
  for (const [k, v] of failures) {
    if (v.until <= now) failures.delete(k);
  }
  // Still over cap after purge (all live): drop oldest entries wholesale.
  if (failures.size >= MAX_BUCKETS) failures.clear();
}

export const auth = createMiddleware<{ Variables: { actor: Actor } }>(async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const key = header.replace(/^Bearer\s+/i, "");
  const bucket = bucketOf(key);
  const now = Date.now();

  const fail = failures.get(bucket);
  if (fail && fail.until > now && fail.count >= MAX_FAILURES) {
    return c.text("Too Many Requests", 429);
  }
  if (fail && fail.until <= now) failures.delete(bucket);

  const recordFailure = () => {
    purgeExpired(now);
    const current = (fail && fail.until > now) ? fail.count : 0;
    failures.set(bucket, { count: current + 1, until: now + WINDOW_MS });
  };

  let actor: Actor;
  try {
    actor = await resolveActor(key);
  } catch {
    recordFailure();
    throw new AuthError("unauthorized");
  }

  if (actor.revoked) {
    recordFailure();
    throw new AuthError("unauthorized");
  }

  failures.delete(bucket);
  c.set("actor", actor);
  await next();
});

// Admin-only gate for routes that touch host state (settings, filesystem
// indexing, config writes, key minting). Runs after `auth`, so a bad key is
// 401 before role is ever considered.
export const requireAdmin = createMiddleware<{ Variables: { actor: Actor } }>(async (c, next) => {
  if (c.get("actor").role !== "admin") throw new ForbiddenError("forbidden");
  await next();
});
