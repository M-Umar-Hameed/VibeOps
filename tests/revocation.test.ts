import { expect, test } from "vitest";
import { createActor } from "../src/services/actors.js";
import { app } from "../src/api/app.js";

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

test("revoke: member forbidden, admin can revoke, revoked key then 401s", async () => {
  const { apiKey: adminKey } = await createActor({ name: uniq("revoke-admin"), kind: "human", role: "admin" });
  const { apiKey: memberKey } = await createActor({ name: uniq("revoke-member"), kind: "agent" });
  const { actor: target, apiKey: targetKey } = await createActor({ name: uniq("revoke-target"), kind: "agent" });
  const adminH = { Authorization: `Bearer ${adminKey}` };
  const memberH = { Authorization: `Bearer ${memberKey}` };
  const targetH = { Authorization: `Bearer ${targetKey}` };

  expect((await app.request(`/actors/${target.id}/revoke`, { method: "POST", headers: memberH })).status).toBe(403);

  expect((await app.request("/tickets", { headers: targetH })).status).toBe(200);

  const revokeRes = await app.request(`/actors/${target.id}/revoke`, { method: "POST", headers: adminH });
  expect(revokeRes.status).toBe(200);
  expect(await revokeRes.json()).toEqual({ id: target.id, revoked: true });

  const afterRevoke = await app.request("/tickets", { headers: targetH });
  expect(afterRevoke.status).toBe(401);
  expect(await afterRevoke.json()).toEqual({ error: "unauthorized" });
});

test("revoke: unknown actor id 404s", async () => {
  const { apiKey: adminKey } = await createActor({ name: uniq("revoke-admin2"), kind: "human", role: "admin" });
  const adminH = { Authorization: `Bearer ${adminKey}` };
  const res = await app.request("/actors/00000000-0000-0000-0000-000000000000/revoke", { method: "POST", headers: adminH });
  expect(res.status).toBe(404);
});

test("revocation is indistinguishable from an invalid key", async () => {
  const { actor: target, apiKey: targetKey } = await createActor({ name: uniq("revoke-indistinct"), kind: "agent" });
  const { apiKey: adminKey } = await createActor({ name: uniq("revoke-admin3"), kind: "human", role: "admin" });
  await app.request(`/actors/${target.id}/revoke`, { method: "POST", headers: { Authorization: `Bearer ${adminKey}` } });

  const revokedRes = await app.request("/tickets", { headers: { Authorization: `Bearer ${targetKey}` } });
  const bogusRes = await app.request("/tickets", { headers: { Authorization: "Bearer not-a-real-key" } });
  expect(revokedRes.status).toBe(bogusRes.status);
  expect(await revokedRes.json()).toEqual(await bogusRes.json());
});

test("owner-created fresh admin key still works after unrelated revocation", async () => {
  const { apiKey: adminKey } = await createActor({ name: uniq("revoke-admin4"), kind: "human", role: "admin" });
  const { actor: victim } = await createActor({ name: uniq("revoke-victim"), kind: "agent" });
  await app.request(`/actors/${victim.id}/revoke`, { method: "POST", headers: { Authorization: `Bearer ${adminKey}` } });

  const { apiKey: freshAdminKey } = await createActor({ name: uniq("revoke-fresh-admin"), kind: "human", role: "admin" });
  expect((await app.request("/system/logs", { headers: { Authorization: `Bearer ${freshAdminKey}` } })).status).toBe(200);
});
