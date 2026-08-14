// Batch executor — Epic C §1.2
// Pure functions operating on a passed document node; no chrome globals.

import { collectInteractive, buildSnapshot } from "./snapshot.js";

const MUTATING_VERBS = new Set(["click", "type", "select", "press"]);
const REFUSAL = { ok: false, error: "verb not enabled until grants land" };

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

/**
 * Execute steps sequentially, stopping on first failure.
 * Always appends a trailing snapshot.
 * @param {Document} doc
 * @param {Array<{verb: string, ref?: string, text?: string, option?: string, key?: string}>} steps
 * @returns {{results: Array<{ok: boolean, value?: string, error?: string}>, snapshot: object}}
 */
export function executeSteps(doc, steps) {
  // Build ref map at entry time (valid for read-only slice)
  // ponytail: read resolves refs against an entry-time collect; valid while DOM is unchanged between snapshot and read (read-only slice). Revisit when writes land.
  const refMap = buildRefMap(doc);
  const results = [];

  for (const step of steps) {
    let result;

    if (MUTATING_VERBS.has(step.verb)) {
      // Refuse mutating verbs without touching DOM
      result = REFUSAL;
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
      // Unknown verb (shouldn't happen if server validates)
      result = { ok: false, error: `unknown verb: ${step.verb}` };
    }

    results.push(result);

    // Stop on first failure
    if (!result.ok) {
      break;
    }
  }

  // Always append trailing snapshot
  const snapshot = buildSnapshot(doc, "");

  return { results, snapshot };
}
