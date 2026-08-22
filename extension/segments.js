// Tab verbs need chrome.tabs, which only the worker has, so a batch is split
// into segments: page segments run inside whichever tab is active at that
// moment, tab verbs run worker-side between them. Pure, so the split is
// testable without a browser.

export const TAB_VERBS = new Set(["tabs", "newTab", "switchTab"]);

/**
 * @param {{verb: string}[]} steps
 * @returns {Array<{kind: "page", steps: object[], start: number} | {kind: "tab", step: object, start: number}>}
 *   start is the index of the segment's first step in the original batch, so
 *   results can be written back in order.
 */
export function splitSegments(steps) {
  const out = [];
  let page = null;
  steps.forEach((step, i) => {
    if (TAB_VERBS.has(step.verb)) {
      page = null;
      out.push({ kind: "tab", step, start: i });
      return;
    }
    if (!page) {
      page = { kind: "page", steps: [], start: i };
      out.push(page);
    }
    page.steps.push(step);
  });
  return out;
}
