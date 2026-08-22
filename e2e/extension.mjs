// E2E: the extension against the LIVE sidecar on 127.0.0.1:8787, in real Chrome.
// Proves the three things jsdom cannot: the options page links through the real
// UI, a batch round-trips through a real service worker, and the 30s heartbeat
// alarm is actually scheduled in the browser. Run: npm run e2e:extension
// ponytail: plain node + asserts, no test runner - one file, three checks.
import { chromium } from "playwright";
import { strict as assert } from "node:assert";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const API = "http://127.0.0.1:8787";
const { apiKey } = JSON.parse(readFileSync(join(process.env.USERPROFILE || process.env.HOME, ".vibeops/credentials.json"), "utf8"));
const extPath = resolve(import.meta.dirname, "../extension");
const H = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

const health = await fetch(`${API}/browser/instances`, { headers: H }).catch(() => null);
if (!health?.ok) { console.error("sidecar not answering on :8787 - start it first"); process.exit(2); }

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "vibeops-e2e-")), {
  headless: false,
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});
try {
  // Wait for the extension service worker; its URL carries the extension id.
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const extId = new URL(sw.url()).host;

  // 1. Link through the real options UI; Linked must be server-confirmed.
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.fill("#apiKey", apiKey);
  await page.click("#save");
  await page.waitForFunction(() => document.getElementById("state").textContent === "Linked", null, { timeout: 10000 });
  const shownId = await page.textContent("#detail");
  const listed = await (await fetch(`${API}/browser/instances`, { headers: H })).json();
  const mine = listed.find((i) => i.instanceId.startsWith(shownId));
  assert.ok(mine, `options page shows ${shownId} but the server list has no such instance - LINKED lied`);
  console.log("ok 1 - options page Linked is server-confirmed:", shownId);

  // 2. The heartbeat alarm is scheduled in the real browser.
  const alarm = await sw.evaluate(() => chrome.alarms.get("poll-heartbeat"));
  assert.ok(alarm, "poll-heartbeat alarm not scheduled");
  assert.equal(alarm.periodInMinutes, 0.5, `alarm period ${alarm.periodInMinutes}, want 0.5`);
  console.log("ok 2 - heartbeat alarm scheduled at 30s");

  // 3. A batch round-trips through the worker's poll loop. The worker may have
  // registered its own instance; use whichever instance is live for this profile.
  await page.goto(`${API}/browser/instances`); // any http page the snapshot can walk
  // Target the WORKER's instance - the one the options page confirmed. Batches
  // to any other listed instance would test someone else's session.
  const res = await fetch(`${API}/browser/batches`, {
    method: "POST", headers: H,
    body: JSON.stringify({ instanceId: mine.instanceId, tenant: "e2e", steps: [{ verb: "snapshot" }] }),
  });
  assert.equal(res.status, 200, `batch returned ${res.status}`);
  const body = await res.json();
  assert.ok(body.snapshot, "batch result carries no snapshot");
  console.log("ok 3 - batch round-tripped through the real worker");

  // 4. Tab verbs through the real worker: grant the sidecar's own origin, open
  // it in a NEW tab, list tabs, and confirm the snapshot now comes from the new tab.
  const grants = await (await fetch(`${API}/settings/browserGrants`, { headers: H })).json();
  const origin = new URL(API).origin;
  const prior = grants.value;
  const withGrant = JSON.stringify([...(prior ? JSON.parse(prior) : []).filter((g) => g.origin !== origin), { origin, mode: "act" }]);
  await fetch(`${API}/settings/browserGrants`, { method: "PATCH", headers: H, body: JSON.stringify({ value: withGrant }) });
  try {
    const beforeRes = await fetch(`${API}/browser/batches`, { method: "POST", headers: H,
      body: JSON.stringify({ instanceId: mine.instanceId, tenant: "e2e", steps: [{ verb: "tabs" }] }) });
    const before = await beforeRes.json();
    assert.equal(beforeRes.status, 200, `tabs batch returned ${beforeRes.status}: ${JSON.stringify(before)}`);
    assert.ok(before.results[0].ok, `tabs step failed: ${before.results[0].error}`);
    const tabsBefore = JSON.parse(before.results[0].value).length;
    const tabRes = await fetch(`${API}/browser/batches`, { method: "POST", headers: H,
      body: JSON.stringify({ instanceId: mine.instanceId, tenant: "e2e", targetOrigin: origin,
        steps: [{ verb: "newTab", url: `${API}/browser/instances` }, { verb: "tabs" }, { verb: "snapshot" }] }) });
    assert.equal(tabRes.status, 200, `newTab batch returned ${tabRes.status}`);
    const body5 = await tabRes.json();
    assert.ok(body5.results[0].ok, `newTab failed: ${body5.results[0].error}`);
    const tabs = JSON.parse(body5.results[1].value);
    assert.equal(tabs.length, tabsBefore + 1, `expected ${tabsBefore + 1} tabs, got ${tabs.length}`);
    assert.ok(tabs.find((t) => t.active && t.url.startsWith(`${API}/browser/instances`)), "new tab is not the active one");
    assert.equal(body5.snapshot.origin, origin, "snapshot did not come from the new tab");
    console.log("ok 4 - newTab opened, listed, and became the snapshot target");
  } finally {
    await fetch(`${API}/settings/browserGrants`, { method: "PATCH", headers: H, body: JSON.stringify({ value: prior ?? "[]" }) });
  }

  // 5. A session the server does not vouch for must never read as Linked.
  // LAST on purpose: the bogus key poisons the worker's polling for anything after.
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.evaluate(() => chrome.storage.local.set({ apiKey: "bogus-key" }));
  await page.reload();
  await page.waitForFunction(() => {
    const t = document.getElementById("state").textContent;
    return t !== "Checking" && t !== "Not linked";
  }, null, { timeout: 10000 });
  const state = await page.textContent("#state");
  assert.notEqual(state, "Linked", "options page claimed Linked on a key the server rejects");
  console.log("ok 5 - unverified session reads as disconnected:", state);

  console.log("PASS");
} finally {
  await ctx.close();
}
