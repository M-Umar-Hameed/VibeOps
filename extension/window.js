// Window-state and screenshot-path helpers for the worker. Pure: chrome APIs are passed in.
import { usesCdp } from "./cdp.js";

// A 4K screen encodes to several MB of base64; rejected, not truncated.
export const MAX_SCREENSHOT_B64 = 8 * 1024 * 1024;

export function wantsPaint(batch) {
  return batch.grant === "act" || batch.steps.some((s) => s?.verb === "screenshot");
}

export function needsDebugger(grant, steps) {
  return steps.some((s) => s?.verb === "screenshot") || (grant === "act" && steps.some(usesCdp));
}

// ponytail: one attachment per worker, kept for DEBUGGER_IDLE_MS after the last batch; the banner stays up that long. Upgrade: make it a per-tab Map if batches ever run concurrently.
export const DEBUGGER_IDLE_MS = 10000;

export function createDebuggerLease({ attach, detach, keepLive, idleMs = DEBUGGER_IDLE_MS, timers = globalThis }) {
  let held = null;
  let timer = null;
  let chain = Promise.resolve();
  const serial = (f) => (chain = chain.then(f, f));
  const cancel = () => { if (timer !== null) { timers.clearTimeout(timer); timer = null; } };
  return {
    acquire: (tabId) => serial(async () => {
      cancel();
      if (held === tabId) return true;
      if (held !== null) { const old = held; held = null; await detach(old); }
      // A restarted worker forgets its attachment while Chrome may still hold it: detach our own session once and retry.
      let ok = await attach(tabId);
      if (!ok) { await detach(tabId); ok = await attach(tabId); }
      if (!ok) return false;
      held = tabId;
      await keepLive(tabId);
      return true;
    }),
    holds: (tabId) => held === tabId,
    release: () => {
      cancel();
      timer = timers.setTimeout(() => {
        timer = null;
        serial(async () => { if (held !== null) { const t = held; held = null; await detach(t); } });
      }, idleMs);
    },
    dropped: (tabId) => { if (held === tabId) held = null; },
  };
}

// Minimized windows do not paint and drop input. Restore WITHOUT focus (stays
// behind the foreground window), run, then re-minimize. Never focused:true,
// never Page.bringToFront.
export async function withPaintableWindow(windows, windowId, wanted, run) {
  let restored = false;
  if (wanted) {
    try {
      const win = await windows.get(windowId);
      if (win.state === "minimized") {
        await windows.update(windowId, { state: "normal", focused: false });
        restored = true;
      }
    } catch { /* window gone: agentTab recreates it; run anyway */ }
  }
  try {
    return await run();
  } finally {
    if (restored) {
      try { await windows.update(windowId, { state: "minimized" }); } catch { /* closed mid-batch */ }
    }
  }
}

// Keeps timers, focus handlers and rendering unthrottled while attached. Best-effort.
export async function keepPageLive(send) {
  try { await send("Emulation.setFocusEmulationEnabled", { enabled: true }); } catch { /* unsupported */ }
  try { await send("Page.setWebLifecycleState", { state: "active" }); } catch { /* unsupported */ }
}

function sized(b64, path) {
  if (b64.length > MAX_SCREENSHOT_B64) {
    return { ok: false, error: `screenshot too large (${b64.length} > ${MAX_SCREENSHOT_B64})`, code: "screenshot_failed", path };
  }
  return { ok: true, value: b64, path };
}

// CDP when attached (works hidden/covered/minimized); captureVisibleTab only when attach failed.
export async function captureScreenshotVia({ cdpReady, send, captureVisibleTab }) {
  if (cdpReady) {
    try {
      const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      return sized(data, "cdp");
    } catch (err) {
      return { ok: false, error: `screenshot failed: ${String(err)}`, code: "screenshot_failed", path: "cdp" };
    }
  }
  try {
    const dataUrl = await captureVisibleTab();
    return sized(dataUrl.slice(dataUrl.indexOf(",") + 1), "visible");
  } catch (err) {
    if (/minimi[sz]ed|readback/i.test(String(err))) {
      return { ok: false, error: "the VibeOps window is not visible and the debugger could not attach - restore the window to take a screenshot", code: "screenshot_failed", path: "visible" };
    }
    return { ok: false, error: `screenshot failed: ${String(err)}`, code: "screenshot_failed", path: "visible" };
  }
}
