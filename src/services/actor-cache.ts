import { ttlCache } from "./ttl-cache.js";
import type { Actor } from "../db/schema.js";

// Auth resolves the actor on every request; the row changes only via create/
// revoke in actors.ts, which invalidate by apiKeyHash. Keyed by that same hash
// (what auth already computes as its throttle bucket), so a revoke is visible
// within one TTL at worst. A thrown resolve (bad key) is never cached.
const cache = ttlCache<Actor>(10_000);

export async function resolveActorCached(keyHash: string, rawKey: string): Promise<Actor> {
  const { resolveActor } = await import("./actors.js");
  return cache.get(keyHash, () => resolveActor(rawKey));
}

export function invalidateActor(keyHash: string): void {
  cache.invalidate(keyHash);
}
