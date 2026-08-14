import { afterEach, expect, test } from "vitest";
import { createActor } from "../src/services/actors.js";
import { app } from "../src/api/app.js";
import { BROWSER_TUNING } from "../src/browser/channel.js";

const DEFAULTS = { ...BROWSER_TUNING };
afterEach(() => Object.assign(BROWSER_TUNING, DEFAULTS));

function uniq(p: string) {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function memberHeaders() {
  const { apiKey } = await createActor({ name: uniq("browser"), kind: "agent" });
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function registerInstance(h: Record<string, string>) {
  const res = await app.request("/browser/instances/register", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ browserChannel: "stable", profileId: "p1", profileLabel: "Work" }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).instanceId as string;
}

// Fake extension: one poll -> execute -> post-result cycle.
async function fakeClientCycle(h: Record<string, string>, instanceId: string, canned: any) {
  const poll = await app.request(`/browser/poll?instanceId=${instanceId}`, { headers: h });
  if (poll.status !== 200) return { polled: poll.status, batch: null as any };
  const batch = await poll.json();
  await app.request("/browser/results", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ batchId: batch.batchId, result: canned }),
  });
  return { polled: 200, batch };
}

test("register then list shows the instance", async () => {
  const h = await memberHeaders();
  const id = await registerInstance(h);
  const listed = await (await app.request("/browser/instances", { headers: h })).json();
  const found = listed.find((i: any) => i.instanceId === id);
  expect(found).toMatchObject({ instanceId: id, browserChannel: "stable", profileId: "p1", profileLabel: "Work" });
  expect(typeof found.connectedAt).toBe("string");
});

test("instance expires after its TTL", async () => {
  BROWSER_TUNING.ttlMs = 50;
  const h = await memberHeaders();
  const id = await registerInstance(h);
  await new Promise((r) => setTimeout(r, 80));
  const listed = await (await app.request("/browser/instances", { headers: h })).json();
  expect(listed.find((i: any) => i.instanceId === id)).toBeUndefined();
  expect((await app.request(`/browser/poll?instanceId=${id}`, { headers: h })).status).toBe(404);
});

test("batch round trip resolves with the result the fake client posts", async () => {
  const h = await memberHeaders();
  const id = await registerInstance(h);
  const canned = {
    results: [{ ok: true, value: "hello" }],
    snapshot: { instanceId: id, origin: "https://x", identity: null, nodes: [] },
  };
  const [batchRes, client] = await Promise.all([
    app.request("/browser/batches", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ instanceId: id, tenant: "acme", steps: [{ verb: "snapshot" }] }),
    }),
    fakeClientCycle(h, id, canned),
  ]);
  expect(client.polled).toBe(200);
  expect(client.batch).toMatchObject({ instanceId: id, tenant: "acme", steps: [{ verb: "snapshot" }] });
  expect(typeof client.batch.batchId).toBe("string");
  expect(batchRes.status).toBe(200);
  expect(await batchRes.json()).toEqual(canned);
});

test("unknown verb is rejected 400 and nothing is enqueued", async () => {
  BROWSER_TUNING.pollTimeoutMs = 80;
  const h = await memberHeaders();
  const id = await registerInstance(h);
  const bad = await app.request("/browser/batches", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ instanceId: id, tenant: "acme", steps: [{ verb: "evaluate", ref: "r1" }] }),
  });
  expect(bad.status).toBe(400);
  // Bare unknown verb: no extra field for the shape check to trip on, so this is
  // the only probe that pins the closed verb SET itself.
  const bare = await app.request("/browser/batches", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ instanceId: id, tenant: "acme", steps: [{ verb: "evaluate" }] }),
  });
  expect(bare.status).toBe(400);
  // Extra field on an otherwise-valid verb is also rejected (injection-defense anchor).
  const extra = await app.request("/browser/batches", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ instanceId: id, tenant: "acme", steps: [{ verb: "click", ref: "r1", onclick: "x" }] }),
  });
  expect(extra.status).toBe(400);
  // Queue is empty: the next poll times out to 204.
  expect((await app.request(`/browser/poll?instanceId=${id}`, { headers: h })).status).toBe(204);
});

test("batch timeout returns 504 and the instance queue stays usable", async () => {
  BROWSER_TUNING.batchTimeoutMs = 100;
  const h = await memberHeaders();
  const id = await registerInstance(h);
  const timed = await app.request("/browser/batches", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ instanceId: id, tenant: "acme", steps: [{ verb: "snapshot" }] }),
  });
  expect(timed.status).toBe(504);
  const canned = {
    results: [{ ok: true }],
    snapshot: { instanceId: id, origin: "https://x", identity: null, nodes: [] },
  };
  const [again] = await Promise.all([
    app.request("/browser/batches", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ instanceId: id, tenant: "acme", steps: [{ verb: "snapshot" }] }),
    }),
    fakeClientCycle(h, id, canned),
  ]);
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual(canned);
});

test("every /browser route requires auth", async () => {
  const calls: [string, RequestInit][] = [
    ["/browser/instances/register", { method: "POST", body: "{}" }],
    ["/browser/instances", {}],
    ["/browser/poll?instanceId=x", {}],
    ["/browser/results", { method: "POST", body: "{}" }],
    ["/browser/batches", { method: "POST", body: "{}" }],
  ];
  for (const [path, init] of calls) {
    expect((await app.request(path, init)).status).toBe(401);
  }
});
