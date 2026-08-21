// Service worker — MV3 background script
// Long-poll loop against local server. Not unit-tested (thin); everything it calls is tested.

const API_BASE = "http://127.0.0.1:8787";

// No popup: the toolbar button opens settings (API key entry).
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

let instanceId = null;
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
    const res = await fetch(`${API_BASE}/browser/poll?instanceId=${instanceId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
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
    console.error("[worker] Poll network error:", err);
    setTimeout(poll, nextBackoff());
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

async function executeBatch(batch) {
  const apiKey = await getApiKey();

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) {
      await submitResult(batch.batchId, {
        results: [{ ok: false, error: "no active tab" }],
        snapshot: { instanceId, origin: "", identity: null, nodes: [] },
      });
      return;
    }

    const tabId = tabs[0].id;

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (steps, grant, targetOrigin) => {
        const { executeSteps } = await import(chrome.runtime.getURL("execute.js"));
        return executeSteps(document, steps, grant, targetOrigin);
      },
      args: [batch.steps, batch.grant ?? null, batch.targetOrigin ?? null],
    });

    // Set instanceId on snapshot
    result.snapshot.instanceId = instanceId;

    // screenshot cannot run in the page: captureVisibleTab is a worker-only API,
    // so execute.js leaves its slot as an unknown-verb error and we fill it here.
    for (let i = 0; i < batch.steps.length; i++) {
      if (batch.steps[i]?.verb !== "screenshot") continue;
      result.results[i] = await captureScreenshot();
    }

    await submitResult(batch.batchId, result);
  } catch (err) {
    console.error("[worker] Execute error:", err);
    await submitResult(batch.batchId, {
      results: [{ ok: false, error: String(err) }],
      snapshot: { instanceId, origin: "", identity: null, nodes: [] },
    });
  }
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

// Start on install
chrome.runtime.onInstalled.addListener(() => {
  console.log("[worker] Installed, starting poll loop");
  poll();
});

// Also start on service worker activation (in case it was terminated and restarted)
poll();
