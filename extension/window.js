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
