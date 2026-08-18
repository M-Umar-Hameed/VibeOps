import { ttlCache } from "./ttl-cache.js";

// cors runs on every request; the raw setting changes only via setSetting, which
// invalidates below. 10s bounds staleness if a write ever races the cache.
const cache = ttlCache<string | null>(10_000);
const CORS_ORIGINS = "cors.origins";

export async function getCorsOrigins(): Promise<string | null> {
  const { getSetting } = await import("./settings.js");
  return cache.get(CORS_ORIGINS, () => getSetting(CORS_ORIGINS));
}

export function invalidateCorsOrigins(): void {
  cache.invalidate(CORS_ORIGINS);
}
