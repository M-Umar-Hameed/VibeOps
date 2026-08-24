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

export function humanizeBrowserError(raw: string | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "the browser returned no reason";
  for (const [re, fn] of RULES) {
    const m = s.match(re);
    if (m) return fn(m);
  }
  return s;
}
