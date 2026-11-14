// E2E: the extension against the LIVE sidecar on 127.0.0.1:8787, in real Chrome.
// Proves the three things jsdom cannot: the options page links through the real
// UI, a batch round-trips through a real service worker, and the 30s heartbeat
// alarm is actually scheduled in the browser. Run: npm run e2e:extension
// Latency benchmark: npm run e2e:extension -- --bench
// ponytail: plain node + asserts, no test runner - one file, three checks.
import { chromium } from "playwright";
import { strict as assert } from "node:assert";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { benchPage } from "./bench-pages.mjs";

const API = "http://127.0.0.1:8787";
const { apiKey } = JSON.parse(readFileSync(join(process.env.USERPROFILE || process.env.HOME, ".vibeops/credentials.json"), "utf8"));
const extPath = resolve(import.meta.dirname, "../extension");
const H = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
const BENCH = process.argv.includes("--bench");
const BENCH_ITERATIONS = 20;

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

  // 3. The extension drives a dedicated agent window, never the owner's own
  // tabs: navigate the TEST's own ctx page to a live URL (so check 4 can prove
  // it never leaks into the agent window's tab list), then send the FIRST
  // batch ever. It targets a never-navigated agent window, so the worker
  // creates a second real Chrome window and a bare snapshot on its
  // about:blank tab fails cleanly instead of crashing.
  await page.goto(`${API}/browser/instances`);
  const windowsBefore = await sw.evaluate(() => chrome.windows.getAll());
  const res = await fetch(`${API}/browser/batches`, {
    method: "POST", headers: H,
    body: JSON.stringify({ instanceId: mine.instanceId, tenant: "e2e", steps: [{ verb: "snapshot" }] }),
  });
  assert.equal(res.status, 200, `batch returned ${res.status}`);
  const body = await res.json();
  assert.equal(body.results[0]?.ok, false, `expected a failed snapshot on a fresh agent window, got: ${JSON.stringify(body.results[0])}`);
  assert.match(body.results[0].error, /no page yet/, `expected the "no page yet" error, got: ${body.results[0].error}`);
  const windowsAfter = await sw.evaluate(() => chrome.windows.getAll());
  assert.equal(windowsAfter.length, windowsBefore.length + 1, `expected a second (agent) window, got ${windowsAfter.length} (was ${windowsBefore.length})`);
  console.log("ok 3 - first action opens a dedicated agent window; a bare snapshot on it fails cleanly");

  // 4. Tab verbs through the real worker: grant the sidecar's own origin, open
  // it in a NEW tab inside the AGENT window, list tabs, and confirm the
  // snapshot now comes from the new tab. The agent window started this check
  // with exactly one tab (the about:blank from check 3); the tabs step must
  // report exactly two (that tab plus the new one) - if the test's own ctx
  // tab (navigated above, in Chrome's other window) leaked in, this would be 3.
  const grants = await (await fetch(`${API}/settings/browserGrants`, { headers: H })).json();
  const origin = new URL(API).origin;
  const prior = grants.value;
  const withGrant = JSON.stringify([...(prior ? JSON.parse(prior) : []).filter((g) => g.origin !== origin), { origin, mode: "act" }]);
  await fetch(`${API}/settings/browserGrants`, { method: "PATCH", headers: H, body: JSON.stringify({ value: withGrant }) });
  try {
    const tabRes = await fetch(`${API}/browser/batches`, { method: "POST", headers: H,
      body: JSON.stringify({ instanceId: mine.instanceId, tenant: "e2e", targetOrigin: origin,
        steps: [{ verb: "newTab", url: `${API}/browser/instances` }, { verb: "tabs" }, { verb: "snapshot" }] }) });
    assert.equal(tabRes.status, 200, `newTab batch returned ${tabRes.status}`);
    const body4 = await tabRes.json();
    assert.ok(body4.results[0].ok, `newTab failed: ${body4.results[0].error}`);
    const tabs = JSON.parse(body4.results[1].value);
    assert.equal(tabs.length, 2, `expected 2 tabs in the agent window (blank + new), got ${tabs.length}: ${JSON.stringify(tabs)}`);
    assert.ok(tabs.find((t) => t.active && t.url.startsWith(`${API}/browser/instances`)), "new tab is not the active one");
    assert.equal(body4.snapshot.origin, origin, "snapshot did not come from the new tab");
    console.log("ok 4 - newTab opened in the agent window, listed there only, and became the snapshot target");
  } finally {
    await fetch(`${API}/settings/browserGrants`, { method: "PATCH", headers: H, body: JSON.stringify({ value: prior ?? "[]" }) });
  }

  if (BENCH) await runBench(sw, mine.instanceId); // before check 5, which poisons the key

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

// nearest-rank percentile; q in (0,1]
function pct(xs, q) { const s = [...xs].sort((a, b) => a - b); return s[Math.max(0, Math.ceil(q * s.length) - 1)]; }
function stats(xs) { const r = (v) => Math.round(v * 10) / 10; return { n: xs.length, medianMs: r(pct(xs, 0.5)), p95Ms: r(pct(xs, 0.95)) }; }

// Latency baseline for browser extension 2/2. Timings are client-observed
// POST /browser/batches round trips (server enqueue -> extension result).
async function runBench(sw, instanceId) {
  const server = createServer((req, res) => {
    const n = req.url === "/large" ? 2000 : req.url === "/small" ? 50 : 0;
    if (!n) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": "text/html" }).end(benchPage(n));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const benchOrigin = `http://127.0.0.1:${server.address().port}`;
  const prior = (await (await fetch(`${API}/settings/browserGrants`, { headers: H })).json()).value;
  const withGrant = JSON.stringify([...(prior ? JSON.parse(prior) : []).filter((g) => g.origin !== benchOrigin), { origin: benchOrigin, mode: "act" }]);
  await fetch(`${API}/settings/browserGrants`, { method: "PATCH", headers: H, body: JSON.stringify({ value: withGrant }) });
  const batch = async (steps) => {
    const t0 = performance.now();
    const res = await fetch(`${API}/browser/batches`, { method: "POST", headers: H,
      body: JSON.stringify({ instanceId, tenant: "e2e", targetOrigin: benchOrigin, steps }) });
    const body = await res.json();
    const ms = performance.now() - t0;
    assert.equal(res.status, 200, `bench batch returned ${res.status}`);
    const bad = body.results.find((r) => !r.ok);
    assert.ok(!bad, `bench step failed: ${JSON.stringify(bad)}`);
    return { ms, body };
  };
  const time = async (steps) => { await batch(steps); const xs = []; for (let i = 0; i < BENCH_ITERATIONS; i++) xs.push((await batch(steps)).ms); return stats(xs); }; // 1 warm-up discarded
  try {
    const report = { bench: "extension-latency", iterations: BENCH_ITERATIONS };
    await batch([{ verb: "newTab", url: `${benchOrigin}/large` }]);
    const large = (await batch([{ verb: "snapshot" }])).body.snapshot.nodes.length;
    assert.ok(large >= 2000, `large page snapshot has ${large} nodes`);
    report.snapshotLarge = { elements: large, ...(await time([{ verb: "snapshot" }])) };
    await batch([{ verb: "newTab", url: `${benchOrigin}/small` }]);
    const nodes = (await batch([{ verb: "snapshot" }])).body.snapshot.nodes;
    assert.ok(nodes.length >= 50, `small page snapshot has ${nodes.length} nodes`);
    const ref = (name) => { const n = nodes.find((x) => x.name === name); assert.ok(n, `bench page has no ${name}`); return n.ref; };
    report.snapshotSmall = { elements: nodes.length, ...(await time([{ verb: "snapshot" }])) };
    report.click = await time([{ verb: "click", ref: ref("bench-click") }]);
    report.type = await time([{ verb: "type", ref: ref("bench-type"), text: "bench" }]);
    report.waitAfter50ms = await time([{ verb: "click", ref: ref("bench-reveal") }, { verb: "wait", text: "bench-ready" }]); // includes the click; subtract report.click
    report.screenshot = await time([{ verb: "screenshot" }]);
    // Raw attach+detach cost, independent of worker behaviour, so it stays meaningful once the debugger is leased.
    report.debuggerAttachDetach = stats(await sw.evaluate(async () => {
      const { agentTabId } = await chrome.storage.session.get("agentTabId");
      const xs = [];
      for (let i = 0; i < 20; i++) {
        try { await chrome.debugger.detach({ tabId: agentTabId }); } catch { /* not attached */ }
        const t = performance.now();
        await chrome.debugger.attach({ tabId: agentTabId }, "1.3");
        await chrome.debugger.detach({ tabId: agentTabId });
        xs.push(performance.now() - t);
      }
      return xs;
    }));
    const patched = await sw.evaluate(() => {
      const orig = chrome.debugger.attach;
      globalThis.__benchAttach = { orig, n: 0 };
      try { chrome.debugger.attach = (...a) => { globalThis.__benchAttach.n++; return orig.apply(chrome.debugger, a); }; } catch { return false; }
      return chrome.debugger.attach !== orig;
    });
    if (patched) {
      for (let i = 0; i < 10; i++) await batch([{ verb: "click", ref: ref("bench-click") }]);
      report.debuggerAttachCallsPer10ActionBatches = await sw.evaluate(() => { const { orig, n } = globalThis.__benchAttach; chrome.debugger.attach = orig; delete globalThis.__benchAttach; return n; });
      // The lease must release the attachment after the idle window. 11000 mirrors DEBUGGER_IDLE_MS (10000) in extension/window.js plus 1 s.
      await new Promise((r) => setTimeout(r, 11000));
      const stillAttached = await sw.evaluate(async () => {
        const { agentTabId } = await chrome.storage.session.get("agentTabId");
        return (await chrome.debugger.getTargets()).some((t) => t.attached && t.tabId === agentTabId);
      });
      assert.equal(stillAttached, false, "debugger still attached after idle window");
    } else {
      report.debuggerAttachCallsPer10ActionBatches = null;
      report.debuggerAttachNote = "chrome.debugger.attach not patchable from the service worker";
    }
    console.log(JSON.stringify(report));
  } finally {
    await fetch(`${API}/settings/browserGrants`, { method: "PATCH", headers: H, body: JSON.stringify({ value: prior ?? "[]" }) });
    server.close();
  }
}
