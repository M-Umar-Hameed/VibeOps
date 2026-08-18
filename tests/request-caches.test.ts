import { expect, test } from "vitest";
import { app } from "../src/api/app.js";
import { createActor, revokeActor } from "../src/services/actors.js";
import { getCorsOrigins } from "../src/services/settings-cache.js";
import { withSetting, clearSetting } from "./helpers/settings.js";

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Trap 1: withSetting writes an override overlay, NOT the DB, and never calls
// setSetting. The cors cache must invalidate from setOverride, or a warmed null
// outlives the override and the cached reader never sees it.
test("cors.origins override taken through withSetting is observed by the cached reader", async () => {
  const ORIGIN = "http://localhost:1421";
  await clearSetting("cors.origins");
  // Warm the cache to null so a missing invalidation would keep serving null.
  expect(await getCorsOrigins()).toBeNull();
  await withSetting("cors.origins", ORIGIN, async () => {
    expect(await getCorsOrigins()).toBe(ORIGIN);
  });
});

// A revoked key must stop authenticating immediately, not after the 10s TTL.
test("revoking an actor invalidates the auth cache immediately", async () => {
  const { actor, apiKey } = await createActor({ name: uniq("revoke"), kind: "agent" });
  const h = { Authorization: `Bearer ${apiKey}` };
  // Warm the actor cache with a live resolution.
  expect((await app.request("/tickets", { headers: h })).status).toBe(200);
  await revokeActor(actor.id);
  // No TTL wait: invalidateActor(apiKeyHash) dropped the entry, so this re-resolves
  // the now-revoked row and 401s.
  expect((await app.request("/tickets", { headers: h })).status).toBe(401);
});
