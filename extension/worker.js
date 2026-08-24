// Service worker — MV3 background script
// Long-poll loop against local server. Not unit-tested (thin); everything it calls is tested.

// Static: MV3 service workers forbid dynamic import(), so a lazy import here
// throws before the batch is ever reported and the server sees a 504.
import { splitSegments } from "./segments.js";

const API_BASE = "http://127.0.0.1:8787";

// No popup: the toolbar button opens settings (API key entry).
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

let instanceId = null;
// True while a poll loop is running in THIS worker instance. Chrome resets it
// by killing the worker; the alarm then finds it false and starts a fresh loop.
// Guards against the alarm stacking a second loop onto a live one, which would
// double-collect batches.
let polling = false;
// In-flight long-poll, so a relink can cut the 25s hold instead of waiting it out.
let pollAbort = null;
let backoff = 1000;
const MAX_BACKOFF = 30000;

function resetBackoff() {
  backoff = 1000;
}

function nextBackoff() {
  backoff = Math.min(MAX_BACKOFF, backoff * 2);
  return backoff;
}

async function getApiKey() {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  return apiKey || null;
}

async function getProfileId() {
  let { profileId } = await chrome.storage.local.get("profileId");
  if (!profileId) {
    profileId = crypto.randomUUID();
    await chrome.storage.local.set({ profileId });
  }
  return profileId;
}

async function register() {
  const apiKey = await getApiKey();
  if (!apiKey) {
    console.log("[worker] No API key configured");
    return null;
  }

  const profileId = await getProfileId();

  try {
    const res = await fetch(`${API_BASE}/browser/instances/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        browserChannel: "chrome",
        profileId,
        profileLabel: "Default",
      }),
    });

    if (!res.ok) {
      console.error("[worker] Registration failed:", res.status);
      return null;
    }

    const data = await res.json();
    instanceId = data.instanceId;
    await chrome.storage.local.set({ instanceId });
    console.log("[worker] Registered:", instanceId);
    return instanceId;
  } catch (err) {
    console.error("[worker] Registration error:", err);
    return null;
  }
}

async function poll() {
  if (!instanceId) {
    const id = await register();
    if (!id) {
      setTimeout(poll, nextBackoff());
      return;
    }
  }

  const apiKey = await getApiKey();
  if (!apiKey) {
    setTimeout(poll, nextBackoff());
    return;
  }

  try {
    const ctl = new AbortController();
    pollAbort = ctl;
    const res = await fetch(`${API_BASE}/browser/poll?instanceId=${instanceId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctl.signal,
    });

    if (res.status === 204) {
      // No batch, reconnect immediately
      resetBackoff();
      poll();
      return;
    }

    if (res.status === 404) {
      // Instance expired, re-register
      instanceId = null;
      poll();
      return;
    }

    if (!res.ok) {
      console.error("[worker] Poll error:", res.status);
      setTimeout(poll, nextBackoff());
      return;
    }

    resetBackoff();
    const batch = await res.json();
    await executeBatch(batch);
    poll();
  } catch (err) {
    // A dropped long-poll (server restart, laptop sleep) is routine: back off
    // and reconnect. An aborted poll is the relink path, not a failure.
    if (err && err.name === "AbortError") { poll(); return; }
    const wait = nextBackoff();
    console.warn(`[worker] VibeOps server unreachable (${err && err.message ? err.message : err}); retrying in ${wait / 1000}s`);
    setTimeout(poll, wait);
  }
}

// A 4K screen encodes to several MB of base64; the channel carries results as
// JSON, so cap rather than let one frame wedge a batch. Rejected, not silently
// truncated — a half image is worse than a named failure.
const MAX_SCREENSHOT_B64 = 8 * 1024 * 1024;

async function captureScreenshot() {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
    const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    if (b64.length > MAX_SCREENSHOT_B64) {
      return { ok: false, error: `screenshot too large (${b64.length} > ${MAX_SCREENSHOT_B64})` };
    }
    return { ok: true, value: b64 };
  } catch (err) {
    return { ok: false, error: `screenshot failed: ${String(err)}` };
  }
}

// Tab verbs (tabs/newTab/switchTab) need chrome.tabs, so the batch is split
// into segments: page segments inject into whichever tab is active when they
// run, tab verbs run here in between. Results go back in original order and
// the batch stops at the first failure, same as execute.js does within a page.
async function executeBatch(batch) {
  const results = new Array(batch.steps.length);
  let snapshot = { instanceId, origin: "", identity: null, nodes: [] };
  try {
    let failed = false;
    for (const seg of splitSegments(batch.steps)) {
      if (failed) break;
      if (seg.kind === "tab") {
        const r = await runTabStep(seg.step, batch.grant ?? null, batch.targetOrigin ?? null);
        results[seg.start] = r;
        if (!r.ok) failed = true;
        continue;
      }
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs.length) {
        results[seg.start] = { ok: false, error: "no active tab" };
        failed = true;
        break;
      }
      const tabId = tabs[0].id;
      const [{ result } = {}] = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (steps, grant, targetOrigin) => {
          const { executeSteps } = await import(chrome.runtime.getURL("execute.js"));
          return executeSteps(document, steps, grant, targetOrigin);
        },
        args: [seg.steps, batch.grant ?? null, batch.targetOrigin ?? null],
      });
      // screenshot cannot run in the page: captureVisibleTab is a worker-only API,
      // so execute.js leaves its slot as an unknown-verb error and we fill it here.
      if (!result) {
        // A navigate inside the segment tears down the injected context and
        // executeScript resolves with no result. Report it; never crash into
        // the catch with a bare TypeError.
        results[seg.start] = { ok: false, error: "the page navigated away before the remaining steps could run - take a fresh snapshot and retry them" };
        failed = true;
        continue;
      }
      for (let i = 0; i < seg.steps.length; i++) {
        const r = seg.steps[i]?.verb === "screenshot" ? await captureScreenshot() : result.results[i];
        if (r === undefined) break; // execute.js stopped early
        results[seg.start + i] = r;
        if (!r.ok) failed = true;
      }
      snapshot = result.snapshot;
    }
    snapshot.instanceId = instanceId;
    await submitResult(batch.batchId, { results: results.filter((r) => r !== undefined), snapshot });
  } catch (err) {
    console.error("[worker] Execute error:", err);
    await submitResult(batch.batchId, {
      results: [{ ok: false, error: String(err) }],
      snapshot: { instanceId, origin: "", identity: null, nodes: [] },
    });
  }
}

const NEW_TAB_LOAD_MS = 15000;

// Resolves when the tab reports status complete, or after the cap; a slow page
// is reported, not silently skipped into a half-loaded snapshot.
function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(onUpdated); clearTimeout(t); resolve(ok); };
    const onUpdated = (id, info) => { if (id === tabId && info.status === "complete") finish(true); };
    const t = setTimeout(() => finish(false), NEW_TAB_LOAD_MS);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === "complete") finish(true); }).catch(() => finish(false));
  });
}

async function runTabStep(step, grant, targetOrigin) {
  if (step.verb === "tabs") {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return { ok: true, value: JSON.stringify(tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active }))) };
  }
  if (step.verb === "switchTab") {
    try {
      await chrome.tabs.update(step.tabId, { active: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `no tab ${step.tabId}: ${String(err)}` };
    }
  }
  if (step.verb === "newTab") {
    // Mirrors navigate: mutating, and the grant must cover the DESTINATION origin.
    let dest = null;
    try { dest = new URL(step.url).origin; } catch { dest = null; }
    if (grant !== "act") return { ok: false, error: `no act grant for ${dest ?? step.url}` };
    if (dest !== targetOrigin) return { ok: false, error: `origin mismatch: newTab ${dest} != granted ${targetOrigin}` };
    const tab = await chrome.tabs.create({ url: step.url, active: true });
    const loaded = await waitForTabLoad(tab.id);
    if (!loaded) return { ok: false, error: "new tab did not finish loading" };
    return { ok: true, value: String(tab.id) };
  }
  return { ok: false, error: `unknown tab verb: ${step.verb}` };
}

async function submitResult(batchId, result) {
  const apiKey = await getApiKey();
  if (!apiKey) return;

  try {
    await fetch(`${API_BASE}/browser/results`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ batchId, result }),
    });
  } catch (err) {
    console.error("[worker] Submit result error:", err);
  }
}

function startPolling() {
  if (polling) return;
  polling = true;
  poll();
}

// Chrome kills an idle MV3 worker (~30s), which silently ends the poll loop and
// with it the heartbeat the server expects. The alarm is the only wakeup that
// survives worker death: every fire restarts the loop if it is not running.
// 0.5 min is the Chrome 120+ floor; the server TTL (90s) tolerates one missed
// fire. Worst case, a batch enqueued right after the worker dies waits ~30s
// plus alarm jitter for the next wake.
// Options page saves a (possibly new) key and asks us to re-register under it.
// Registration is the WORKER's job - the options page never registers, so the
// server list holds one instance per profile, never a phantom nobody polls.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg !== "relink") return;
  instanceId = null;
  resetBackoff();
  if (pollAbort) pollAbort.abort(); // cut the in-flight poll; its catch reschedules
  startPolling(); // no-op if the loop is alive; starts it if this message woke us
});

chrome.alarms.create("poll-heartbeat", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "poll-heartbeat") startPolling();
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("[worker] Installed, starting poll loop");
  startPolling();
});

// Also start on service worker activation (terminated and restarted).
startPolling();
