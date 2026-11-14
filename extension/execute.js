// Batch executor — Epic C §1.2
// Pure functions operating on a passed document node; no chrome globals.

import { collectInteractive, buildSnapshot } from "./snapshot.js";
import { keyCodeName, keyCodeNumber, usesCdp, centrePoint, frameOffset } from "./cdp.js";

const MUTATING_VERBS = new Set(["click", "type", "select", "press", "clickAt"]);

// Bound the wait for the destination document to load after a navigate; the
// step fails past this. Mutable so a jsdom test can shrink it if needed.
export const NAV_TUNING = { loadTimeoutMs: 15000 };

export const WAIT_TUNING = { timeoutMs: 10000 };

// A ref whose element left the document is stale, same as an unknown ref.
function liveRef(refMap, ref) {
  const el = refMap.get(ref);
  return el && el.isConnected ? el : undefined;
}

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

function waitForText(doc, text) {
  const view = doc.defaultView;
  const has = () => (doc.body?.innerText ?? doc.body?.textContent ?? "").includes(text);
  if (has()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (ok) => { obs.disconnect(); view.clearTimeout(timer); resolve(ok); };
    const obs = new view.MutationObserver(() => { if (has()) finish(true); });
    const timer = view.setTimeout(() => finish(has()), WAIT_TUNING.timeoutMs);
    obs.observe(doc.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
  });
}

export async function executeSteps(doc, steps, grant, targetOrigin, opts = {}) {
  // ponytail: refs resolved at entry and re-collected after a navigate; valid
  // across a stop-on-first batch whose steps target one snapshot.
  let refMap = opts.refMap ?? buildRefMap(doc);
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
        result = { ok: false, error: `no act grant for ${targetOrigin}`, code: "no_grant" };
      } else if (destOrigin !== targetOrigin) {
        result = { ok: false, error: `origin mismatch: navigate ${destOrigin} != granted ${targetOrigin}`, code: "origin_mismatch" };
      } else {
        const loaded = await navigateAndWait(doc, step.url);
        if (!loaded) {
          result = { ok: false, error: "navigation timed out", code: "navigation_timeout" };
        } else {
          refMap = buildRefMap(doc); // re-collect refs against the destination
          result = { ok: true };
        }
      }
    } else if (MUTATING_VERBS.has(step.verb)) {
      const origin = doc.location?.origin ?? ""; // recomputed per step: a prior navigate moved it
      if (grant !== "act") {
        result = { ok: false, error: `no act grant for ${origin}`, code: "no_grant" };
      } else if (origin !== targetOrigin) {
        result = { ok: false, error: `origin mismatch: page ${origin} != granted ${targetOrigin}`, code: "origin_mismatch" };
      } else {
        result = (opts.trusted && usesCdp(step) ? prepareTrusted(doc, refMap, step) : null) ?? runMutation(doc, refMap, step);
      }
    } else if (step.verb === "snapshot") {
      result = { ok: true };
    } else if (step.verb === "read") {
      const el = liveRef(refMap, step.ref);
      if (!el) {
        result = { ok: false, error: "that element reference is stale - take a fresh snapshot and use its refs", code: "stale_ref" };
      } else {
        const text = (el.textContent || "").trim();
        result = { ok: true, value: text };
      }
    } else if (step.verb === "wait") {
      if (await waitForText(doc, step.text)) {
        refMap = buildRefMap(doc);
        result = { ok: true };
      } else {
        result = { ok: false, error: `text "${step.text}" did not appear within ${WAIT_TUNING.timeoutMs / 1000}s`, code: "wait_timeout" };
      }
    } else if (step.verb === "scroll") {
      if (typeof step.ref === "string") {
        const el = liveRef(refMap, step.ref);
        if (!el) {
          result = { ok: false, error: "that element reference is stale - take a fresh snapshot and use its refs", code: "stale_ref" };
        } else {
          el.scrollIntoView?.({ block: "center" });
          result = { ok: true };
        }
      } else {
        if (opts.trusted) {
          result = { ok: true, cdp: { verb: "scroll", dy: step.dy, w: doc.defaultView.innerWidth, h: doc.defaultView.innerHeight } };
        } else {
          doc.defaultView.scrollBy(0, step.dy);
          result = { ok: true };
        }
      }
    } else {
      result = { ok: false, error: `this extension build does not support the action "${step.verb}" - update the extension from the latest release`, code: "unsupported_verb" };
    }

    results.push(result);
    if (!result.ok) break;
    if (result.cdp) return { results, snapshot: null, refMap };
  }

  const snapshot = buildSnapshot(doc, "");
  return { results, snapshot, refMap };
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

function clickAtPoint(doc, view, step) {
  const vx = step.x - (view.scrollX || 0);
  const vy = step.y - (view.scrollY || 0);
  const w = view.innerWidth || 0;
  const h = view.innerHeight || 0;
  if (vx < 0 || vy < 0 || (w > 0 && vx > w) || (h > 0 && vy > h)) {
    return { ok: false, error: `point (${step.x},${step.y}) is outside the viewport`, code: "out_of_viewport" };
  }
  const target = doc.elementFromPoint(vx, vy);
  // No fallback to body: a dead zone must report failure, not click something else.
  if (!target) return { ok: false, error: `no element at (${step.x},${step.y})`, code: "no_element" };
  return { vx, vy, target };
}

function prepareTrusted(doc, refMap, step) {
  const view = doc.defaultView;
  if (step.verb === "press") {
    return { ok: true, cdp: { verb: "press", key: step.key } };
  }
  if (step.verb === "clickAt") {
    const p = clickAtPoint(doc, view, step);
    if (!p.target) return p;
    const o = frameOffset(view);
    return { ok: true, cdp: { verb: "click", x: p.vx + o.x, y: p.vy + o.y } };
  }
  if (step.verb === "click" || step.verb === "type") {
    const el = liveRef(refMap, step.ref);
    if (!el) return { ok: false, error: "that element reference is stale - take a fresh snapshot and use its refs", code: "stale_ref" };
    const edoc = el.ownerDocument;
    const eview = edoc.defaultView;
    el.scrollIntoView?.({ block: "center", behavior: "instant" });
    if (step.verb === "click") {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        // ponytail: zero-size/hidden targets keep the synthetic path
        return null;
      }
      const local = centrePoint(r);
      // Hit-test in the element's own root: a document-level hit retargets to the shadow host.
      const root = el.getRootNode();
      const hitRoot = typeof root.elementFromPoint === "function" ? root : edoc;
      const hit = hitRoot.elementFromPoint(local.x, local.y);
      if (!hit || (hit !== el && !el.contains(hit))) {
        const r2 = el.getBoundingClientRect();
        if (r2.left !== r.left || r2.top !== r.top) {
          return { ...runMutation(doc, refMap, step), fallback: "scroll_unsettled" };
        }
        return { ok: false, error: `element ${step.ref} is covered at (${Math.round(local.x)},${Math.round(local.y)})${hit ? ` by <${hit.tagName.toLowerCase()}>` : ""} - scroll, close the overlay, or take a fresh snapshot`, code: "not_hittable" };
      }
      // Walk up same-origin frames: the frame element must be what the parent sees at the mapped point. Cross-origin parents end the walk (out of scope).
      let px = local.x, py = local.y, w = eview;
      for (;;) {
        let fe = null;
        try { fe = w.frameElement; } catch { fe = null; }
        if (!fe) break;
        const fr = fe.getBoundingClientRect();
        px += fr.left; py += fr.top;
        const pdoc = fe.ownerDocument;
        const top = pdoc.elementFromPoint(px, py);
        if (top !== fe) return { ok: false, error: `element ${step.ref} is covered at (${Math.round(px)},${Math.round(py)})${top ? ` by <${top.tagName.toLowerCase()}>` : ""} - scroll, close the overlay, or take a fresh snapshot`, code: "not_hittable" };
        w = pdoc.defaultView;
      }
      return { ok: true, cdp: { verb: "click", ...centrePoint(r, frameOffset(eview)) } };
    }
    if (step.verb === "type") {
      el.focus();
      if (el.isContentEditable || el.getAttribute("contenteditable") !== null) {
        edoc.getSelection()?.selectAllChildren(el);
      } else if (typeof el.select === "function") {
        el.select();
      }
      return { ok: true, cdp: { verb: "type", text: step.text } };
    }
  }
  return null;
}

function runMutation(doc, refMap, step) {
  let view = doc.defaultView;
  if (step.verb === "press") {
    const el = doc.activeElement || doc.body;
    // Real key sequence: frameworks check code/keyCode and listen on keypress,
    // and a bare keydown with only key set is ignored by rich editors (Gemini
    // never submitted). Enter on a plain form field also submits the form
    // unless a handler took the default.
    const init = { key: step.key, code: keyCodeName(step.key), keyCode: keyCodeNumber(step.key), which: keyCodeNumber(step.key), bubbles: true, cancelable: true };
    const down = new view.KeyboardEvent("keydown", init);
    const notPrevented = el.dispatchEvent(down);
    el.dispatchEvent(new view.KeyboardEvent("keypress", init));
    el.dispatchEvent(new view.KeyboardEvent("keyup", init));
    if (notPrevented && step.key === "Enter" && el.form && typeof el.form.requestSubmit === "function" && el.tagName === "INPUT") {
      el.form.requestSubmit();
    }
    return { ok: true };
  }
  // clickAt is the last resort for surfaces the accessibility tree cannot see
  // (canvas, image-only controls). It takes PAGE coordinates; elementFromPoint
  // takes VIEWPORT coordinates, so subtract scroll. A point outside the viewport
  // is refused rather than clamped - clamping would click something the caller
  // never aimed at. Still act-gated server-side like every mutating verb.
  if (step.verb === "clickAt") {
    const p = clickAtPoint(doc, view, step);
    if (!p.target) return p;
    p.target.dispatchEvent(new view.MouseEvent("click", {
      bubbles: true, cancelable: true, clientX: p.vx, clientY: p.vy,
    }));
    return { ok: true };
  }
  const el = liveRef(refMap, step.ref);
  if (!el) return { ok: false, error: "that element reference is stale - take a fresh snapshot and use its refs", code: "stale_ref" };
  // Element verbs use the element's own realm (it may live in a same-origin frame).
  view = el.ownerDocument.defaultView;
  if (step.verb === "click") {
    el.scrollIntoView?.({ block: "center" });
    if (el.getAttribute("role") === "option") {
      // react-select selects on mousedown in some versions; el.click() alone never fires it.
      for (const type of ["mousedown", "mouseup", "click"]) {
        el.dispatchEvent(new view.MouseEvent(type, { bubbles: true, cancelable: true, view }));
      }
    } else {
      el.click();
    }
    return { ok: true };
  }
  if (step.verb === "type") {
    if (el.isContentEditable || el.getAttribute("contenteditable") !== null) {
      el.scrollIntoView?.({ block: "center" });
      // Rich editors have no .value: focus, then insert text the way a keyboard
      // would so the editor's own input handling sees it.
      el.focus();
      let inserted = false;
      try { inserted = el.ownerDocument.execCommand && el.ownerDocument.execCommand("insertText", false, step.text); } catch { inserted = false; }
      if (!inserted) {
        el.textContent = step.text;
        el.dispatchEvent(new view.InputEvent("input", { bubbles: true, inputType: "insertText", data: step.text }));
      }
      return { ok: true };
    }
    el.scrollIntoView?.({ block: "center" });
    el.focus();
    let proto = Object.getPrototypeOf(el);
    let setter;
    while (proto) {
      setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) break;
      proto = Object.getPrototypeOf(proto);
    }
    if (setter) setter.call(el, step.text); else el.value = step.text;
    el.dispatchEvent(new view.Event("input", { bubbles: true }));
    el.dispatchEvent(new view.Event("change", { bubbles: true }));
    return { ok: true };
  }
  if (step.verb === "select") {
    el.value = step.option;
    el.dispatchEvent(new view.Event("change", { bubbles: true }));
    return { ok: true };
  }
  return { ok: false, error: `this extension build does not support the action "${step.verb}" - update the extension from the latest release`, code: "unsupported_verb" };
}
