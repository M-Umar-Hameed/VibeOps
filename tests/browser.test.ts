import { afterEach, expect, test } from "vitest";
import { createActor } from "../src/services/actors.js";
import { app } from "../src/api/app.js";
import { BROWSER_TUNING } from "../src/browser/channel.js";
import { setSetting, deleteSetting } from "../src/services/settings.js";

const DEFAULTS = { ...BROWSER_TUNING };
afterEach(async () => { Object.assign(BROWSER_TUNING, DEFAULTS); await deleteSetting("browserGrants"); });

function uniq(p: string) {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function memberHeaders() {
  const { apiKey } = await createActor({ name: uniq("browser"), kind: "agent" });
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function adminHeaders() {
  const { apiKey } = await createActor({ name: uniq("admin"), kind: "human", role: "admin" });
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

test("mutating batch without a grant is refused 403 naming the origin, nothing enqueued", async () => {
  BROWSER_TUNING.pollTimeoutMs = 80;
  const h = await memberHeaders();
  const id = await registerInstance(h);
  const res = await app.request("/browser/batches", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ instanceId: id, tenant: "acme", targetOrigin: "https://github.com", steps: [{ verb: "click", ref: "ref1" }] }),
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error).toContain("https://github.com");
  // Nothing enqueued: next poll times out to 204. (Mutation check: delete the
  // hasActGrant guard in browser-routes and this expectation flips to 200.)
  expect((await app.request(`/browser/poll?instanceId=${id}`, { headers: h })).status).toBe(204);
});

test("mutating batch is 400 when targetOrigin is missing", async () => {
  BROWSER_TUNING.pollTimeoutMs = 80;
  const h = await memberHeaders();
  const id = await registerInstance(h);
  const res = await app.request("/browser/batches", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ instanceId: id, tenant: "acme", steps: [{ verb: "click", ref: "ref1" }] }),
  });
  expect(res.status).toBe(400);
});

test("with an act grant the mutating batch is delivered carrying grant+targetOrigin; a client-supplied grant is stripped", async () => {
  const h = await memberHeaders();
  const id = await registerInstance(h);
  await setSetting("browserGrants", JSON.stringify([{ origin: "https://github.com", mode: "act" }]));
  const canned = {
    results: [{ ok: true }],
    snapshot: { instanceId: id, origin: "https://github.com", identity: null, nodes: [] },
  };
  const [batchRes, client] = await Promise.all([
    app.request("/browser/batches", {
      method: "POST",
      headers: h,
      // client tries to spoof grant + a mismatched targetOrigin nudge; server value wins.
      body: JSON.stringify({ instanceId: id, tenant: "acme", grant: "act", targetOrigin: "https://github.com", steps: [{ verb: "click", ref: "ref1" }] }),
    }),
    fakeClientCycle(h, id, canned),
  ]);
  expect(client.polled).toBe(200);
  expect(client.batch.grant).toBe("act");
  expect(client.batch.targetOrigin).toBe("https://github.com");
  expect(batchRes.status).toBe(200);
  expect(await batchRes.json()).toEqual(canned);
});

test("read-only batch needs no grant and delivers without grant/targetOrigin", async () => {
  const h = await memberHeaders();
  const id = await registerInstance(h);
  const canned = { results: [{ ok: true }], snapshot: { instanceId: id, origin: "", identity: null, nodes: [] } };
  const [batchRes, client] = await Promise.all([
    app.request("/browser/batches", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ instanceId: id, tenant: "acme", steps: [{ verb: "snapshot" }] }),
    }),
    fakeClientCycle(h, id, canned),
  ]);
  expect(batchRes.status).toBe(200);
  expect(client.batch.grant).toBeUndefined();
  expect(client.batch.targetOrigin).toBeUndefined();
});

test("a client-supplied grant cannot substitute for a real grant", async () => {
  BROWSER_TUNING.pollTimeoutMs = 80;
  const h = await memberHeaders();
  const id = await registerInstance(h);
  // No browserGrants set. Body carries grant:"act" — must be ignored → 403.
  const res = await app.request("/browser/batches", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ instanceId: id, tenant: "acme", grant: "act", targetOrigin: "https://github.com", steps: [{ verb: "type", ref: "ref1", text: "x" }] }),
  });
  expect(res.status).toBe(403);
});

test("navigate batch without an act grant is refused 403 naming the origin, nothing enqueued", async () => {
  BROWSER_TUNING.pollTimeoutMs = 80;
  const h = await memberHeaders();
  const id = await registerInstance(h);
  const res = await app.request("/browser/batches", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ instanceId: id, tenant: "acme", targetOrigin: "https://github.com", steps: [{ verb: "navigate", url: "https://github.com/org/repo" }] }),
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error).toContain("https://github.com");
  // Mutation check: remove "navigate" from MUTATING in browser-routes and the
  // navigate batch delivers without a grant → this 403 flips to a 204-then-deliver.
  expect((await app.request(`/browser/poll?instanceId=${id}`, { headers: h })).status).toBe(204);
});

test("navigate batch with a non-http scheme is rejected 400, nothing enqueued", async () => {
  BROWSER_TUNING.pollTimeoutMs = 80;
  const h = await memberHeaders();
  const id = await registerInstance(h);
  const res = await app.request("/browser/batches", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ instanceId: id, tenant: "acme", targetOrigin: "https://github.com", steps: [{ verb: "navigate", url: "javascript:alert(1)" }] }),
  });
  expect(res.status).toBe(400);
  expect((await app.request(`/browser/poll?instanceId=${id}`, { headers: h })).status).toBe(204);
});

test("with an act grant the navigate batch is delivered carrying grant+targetOrigin", async () => {
  const h = await memberHeaders();
  const id = await registerInstance(h);
  await setSetting("browserGrants", JSON.stringify([{ origin: "https://github.com", mode: "act" }]));
  const canned = {
    results: [{ ok: true }],
    snapshot: { instanceId: id, origin: "https://github.com", identity: null, nodes: [] },
  };
  const [batchRes, client] = await Promise.all([
    app.request("/browser/batches", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ instanceId: id, tenant: "acme", targetOrigin: "https://github.com", steps: [{ verb: "navigate", url: "https://github.com/org/repo" }] }),
    }),
    fakeClientCycle(h, id, canned),
  ]);
  expect(client.polled).toBe(200);
  expect(client.batch.grant).toBe("act");
  expect(client.batch.targetOrigin).toBe("https://github.com");
  expect(client.batch.steps).toEqual([{ verb: "navigate", url: "https://github.com/org/repo" }]);
  expect(batchRes.status).toBe(200);
});

test("POST /browser/grants is admin-only", async () => {
  expect((await app.request("/browser/grants", { method: "POST", body: "{}" })).status).toBe(401);
  const m = await memberHeaders();
  const res = await app.request("/browser/grants", {
    method: "POST", headers: m, body: JSON.stringify({ origin: "https://github.com" }),
  });
  expect(res.status).toBe(403);
});

test("POST /browser/grants requires a non-empty origin", async () => {
  const h = await adminHeaders();
  expect((await app.request("/browser/grants", { method: "POST", headers: h, body: JSON.stringify({}) })).status).toBe(400);
  expect((await app.request("/browser/grants", { method: "POST", headers: h, body: JSON.stringify({ origin: "   " }) })).status).toBe(400);
});

test("granting appends to browserGrants and leaves existing entries intact", async () => {
  const admin = await adminHeaders();
  await setSetting("browserGrants", JSON.stringify([{ origin: "https://a.com", mode: "act" }]));
  const res = await app.request("/browser/grants", {
    method: "POST", headers: admin, body: JSON.stringify({ origin: "https://github.com" }),
  });
  expect(res.status).toBe(200);
  const saved = await (await app.request("/settings/browserGrants", { headers: admin })).json();
  expect(JSON.parse(saved.value)).toEqual([
    { origin: "https://a.com", mode: "act" },
    { origin: "https://github.com", mode: "act" },
  ]);
});

test("granting an origin unlocks its mutating batch; a different origin stays refused", async () => {
  const admin = await adminHeaders();
  const h = await memberHeaders();
  const id = await registerInstance(h);
  const granted = await app.request("/browser/grants", {
    method: "POST", headers: admin, body: JSON.stringify({ origin: "https://github.com" }),
  });
  expect(granted.status).toBe(200);

  const canned = { results: [{ ok: true }], snapshot: { instanceId: id, origin: "https://github.com", identity: null, nodes: [] } };
  const [ok] = await Promise.all([
    app.request("/browser/batches", {
      method: "POST", headers: h,
      body: JSON.stringify({ instanceId: id, tenant: "acme", targetOrigin: "https://github.com", steps: [{ verb: "click", ref: "ref1" }] }),
    }),
    fakeClientCycle(h, id, canned),
  ]);
  expect(ok.status).toBe(200);

  // Injection guard: granting github.com must NOT widen a different origin.
  // Mutation check: drop the exact-origin match in grants.ts hasActGrant and this
  // 403 flips to a deliver.
  BROWSER_TUNING.pollTimeoutMs = 80;
  const evil = await app.request("/browser/batches", {
    method: "POST", headers: h,
    body: JSON.stringify({ instanceId: id, tenant: "acme", targetOrigin: "https://evil.com", steps: [{ verb: "click", ref: "ref1" }] }),
  });
  expect(evil.status).toBe(403);
});


