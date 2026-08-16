// Batch executor — Epic C §1.2
// Pure functions operating on a passed document node; no chrome globals.

import { collectInteractive, buildSnapshot } from "./snapshot.js";

const MUTATING_VERBS = new Set(["click", "type", "select", "press"]);

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

export function executeSteps(doc, steps, grant, targetOrigin) {
  // ponytail: refs resolved once at entry; valid across a stop-on-first batch
  // whose steps target one snapshot. Re-collect per step if a recipe mutates DOM
  // mid-batch and needs fresh refs.
  const refMap = buildRefMap(doc);
  const origin = doc.location?.origin ?? "";
  const results = [];

  for (const step of steps) {
    let result;

    if (MUTATING_VERBS.has(step.verb)) {
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
