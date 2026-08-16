// Batch executor — Epic C §1.2
// Pure functions operating on a passed document node; no chrome globals.

import { collectInteractive, buildSnapshot } from "./snapshot.js";

const MUTATING_VERBS = new Set(["click", "type", "select", "press"]);

// Bound the wait for the destination document to load after a navigate; the
// step fails past this. Mutable so a jsdom test can shrink it if needed.
export const NAV_TUNING = { loadTimeoutMs: 15000 };

/**
 * Build ref→element map from interactive elements.
 * @param {Document} doc
 * @returns {Map<string, Element>}
 */
function buildRefMap(doc) {
  const interactive = collectInteractive(doc);
  const map = new Map();
  interactive.forEach((item, i) => {
    map.set(`ref${i + 1}`, item.element);
  });
  return map;
}

export async function executeSteps(doc, steps, grant, targetOrigin) {
  // ponytail: refs resolved at entry and re-collected after a navigate; valid
  // across a stop-on-first batch whose steps target one snapshot.
  let refMap = buildRefMap(doc);
  const results = [];

  for (const step of steps) {
    let result;

    if (step.verb === "navigate") {
      // Mutating: needs an act grant, and the grant binds to the DESTINATION
      // origin (new URL(url).origin === targetOrigin) — not the current page
      // origin — before location is ever touched. Server mirrors the grant
      // demand via MUTATING in browser-routes; this is the destination guard.
      let destOrigin = null;
      try { destOrigin = new URL(step.url).origin; } catch { destOrigin = null; }
      if (grant !== "act") {
        result = { ok: false, error: `no act grant for ${targetOrigin}` };
      } else if (destOrigin !== targetOrigin) {
        result = { ok: false, error: `origin mismatch: navigate ${destOrigin} != granted ${targetOrigin}` };
      } else {
        const loaded = await navigateAndWait(doc, step.url);
        if (!loaded) {
          result = { ok: false, error: "navigation timed out" };
        } else {
          refMap = buildRefMap(doc); // re-collect refs against the destination
          result = { ok: true };
        }
      }
    } else if (MUTATING_VERBS.has(step.verb)) {
      const origin = doc.location?.origin ?? ""; // recomputed per step: a prior navigate moved it
      if (grant !== "act") {
        result = { ok: false, error: `no act grant for ${origin}` };
      } else if (origin !== targetOrigin) {
        result = { ok: false, error: `origin mismatch: page ${origin} != granted ${targetOrigin}` };
      } else {
        result = runMutation(doc, refMap, step);
      }
    } else if (step.verb === "snapshot") {
      result = { ok: true };
    } else if (step.verb === "read") {
      const el = refMap.get(step.ref);
      if (!el) {
        result = { ok: false, error: "unknown ref" };
      } else {
        const text = (el.textContent || "").trim();
        result = { ok: true, value: text };
      }
    } else {
      result = { ok: false, error: `unknown verb: ${step.verb}` };
    }

    results.push(result);
    if (!result.ok) break;
  }

  const snapshot = buildSnapshot(doc, "");
  return { results, snapshot };
}

// Assign the current tab's location and resolve true when the destination fires
// load, false on timeout. jsdom drives the load via a dispatched event; in the
// extension the injected script awaits the page's own load event.
// ponytail: a real MV3 navigation tears down THIS injected context — surviving it
// end-to-end needs a persistent content-script bridge (out of this slice). The
// load-wait + ref re-collection is what the jsdom suite pins; worker.js unchanged.
function navigateAndWait(doc, url) {
  const view = doc.defaultView;
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      view.clearTimeout(timer);
      view.removeEventListener("load", onLoad);
      resolve(ok);
    };
    const onLoad = () => finish(true);
    const timer = view.setTimeout(() => finish(false), NAV_TUNING.loadTimeoutMs);
    view.addEventListener("load", onLoad);
    doc.location.assign(url);
  });
}

// Refs come only from the snapshot map (1.5): verbs act on refs, never on
// selectors derived from page text.
function runMutation(doc, refMap, step) {
  const view = doc.defaultView;
  if (step.verb === "press") {
    const el = doc.activeElement || doc.body;
    el.dispatchEvent(new view.KeyboardEvent("keydown", { key: step.key, bubbles: true }));
    el.dispatchEvent(new view.KeyboardEvent("keyup", { key: step.key, bubbles: true }));
    return { ok: true };
  }
  const el = refMap.get(step.ref);
  if (!el) return { ok: false, error: "unknown ref" };
  if (step.verb === "click") {
    el.click();
    return { ok: true };
  }
  if (step.verb === "type") {
    el.value = step.text;
    el.dispatchEvent(new view.Event("input", { bubbles: true }));
    el.dispatchEvent(new view.Event("change", { bubbles: true }));
    return { ok: true };
  }
  if (step.verb === "select") {
    el.value = step.option;
    el.dispatchEvent(new view.Event("change", { bubbles: true }));
    return { ok: true };
  }
  return { ok: false, error: `unknown verb: ${step.verb}` };
}
