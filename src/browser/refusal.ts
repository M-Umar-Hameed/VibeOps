// Turns raw extension/channel error strings into sentences a person can act
// on. Older extension builds still emit the terse forms; the server owns the
// wording the owner reads, so translate here rather than trusting every build.
const RULES: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^unknown verb:?\s*(\S+)/i, (m) => `this extension build does not support the action "${m[1]}" - update the extension from the latest release`],
  [/^unknown ref$/i, () => "that element reference is stale - take a fresh snapshot and use its refs"],
  [/Cannot access contents of the page|must request permission to access the respective host/i,
    () => "Chrome is blocking the extension on this site - open chrome://extensions, choose VibeOps > Details, set Site access to \"On all sites\", then reload the tab"],
  [/^no active tab$/i, () => "no browser tab is active - open a normal http(s) page in the linked browser and retry"],
  [/batch timed out|no extension response/i, () => "the browser extension did not answer in time - check it shows Linked in its options page, then retry"],
];

const CODES: Record<string, string> = {
  stale_ref: "that element reference is stale - take a fresh snapshot and use its refs",
  unsupported_verb: "this extension build does not support that action - update the extension from the latest release",
  no_grant: "the agent has no act grant for this site - grant it from the VibeOps browser panel and retry",
  origin_mismatch: "the page is on a different site than the one granted - grant the new site or navigate back",
  navigation_timeout: "the page did not finish loading in time - retry or check the site is reachable",
  screenshot_failed: "the screenshot could not be taken",
  out_of_viewport: "that point is outside the visible page - scroll or take a fresh snapshot",
  no_element: "there is no element at that point - take a fresh snapshot and retry",
  not_hittable: "another element is covering the target - scroll, close the overlay, or take a fresh snapshot",
  no_page: "the agent window has no page yet - navigate to a URL first",
  page_navigated: "the page navigated away before the remaining steps could run - take a fresh snapshot and retry them",
  wait_timeout: "the text did not appear on the page in time - take a snapshot to see what the page shows",
};

const rewrite = (s: string) => {
  for (const [re, fn] of RULES) {
    const m = s.match(re);
    if (m) return fn(m);
  }
  return null;
};

export function humanizeBrowserError(raw: string | undefined, code?: string): string {
  const s = (raw ?? "").trim();
  if (code && CODES[code]) {
    if (!s || s === CODES[code]) return CODES[code];
    if (code === "unsupported_verb" && s.startsWith("this extension build does not support")) return s;
    return rewrite(s) ?? `${CODES[code]}: ${s}`;
  }
  if (!s) return "the browser returned no reason";
  return rewrite(s) ?? s;
}
