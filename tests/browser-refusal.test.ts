import { expect, test } from "vitest";
import { humanizeBrowserError } from "../src/browser/refusal.js";

test("legacy extension errors become sentences a person can act on", () => {
  expect(humanizeBrowserError("unknown verb: newTab")).toContain('does not support the action "newTab"');
  expect(humanizeBrowserError("unknown verb: tabs")).toContain("update the extension");
  expect(humanizeBrowserError("unknown ref")).toContain("fresh snapshot");
  expect(humanizeBrowserError("Error: Cannot access contents of the page. Extension manifest must request permission to access the respective host."))
    .toContain("Site access");
  expect(humanizeBrowserError("no active tab")).toContain("open a normal http(s) page");
});

test("already-human and unknown errors pass through unchanged; empty gets a reason", () => {
  const friendly = "Browser actions on https://x are not allowed yet. Approve the Allow prompt in this chat";
  expect(humanizeBrowserError(friendly)).toBe(friendly);
  expect(humanizeBrowserError("something new")).toBe("something new");
  expect(humanizeBrowserError(undefined)).toBe("the browser returned no reason");
});

const MSGS: Record<string, string> = {
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

test("a known code prefixes its message and keeps the raw detail", () => {
  for (const [code, msg] of Object.entries(MSGS)) {
    expect(humanizeBrowserError("totally reworded text", code)).toBe(`${msg}: totally reworded text`);
  }
});

test("legacy rule wording wins when the original text comes with a code", () => {
  expect(humanizeBrowserError("unknown ref", "stale_ref")).toBe(humanizeBrowserError("unknown ref"));
  expect(humanizeBrowserError("unknown verb: x", "unsupported_verb"))
    .toBe(humanizeBrowserError("unknown verb: x"));
});

test("empty raw with a code gives the bare message", () => {
  expect(humanizeBrowserError("", "no_grant")).toBe(MSGS.no_grant);
});

test("unknown code falls back to the text rules", () => {
  expect(humanizeBrowserError("unknown ref", "nope")).toBe(humanizeBrowserError("unknown ref"));
  expect(humanizeBrowserError("something new", "nope")).toBe("something new");
});

test("real extension strings with a code are not doubled", () => {
  const stale = "that element reference is stale - take a fresh snapshot and use its refs";
  expect(humanizeBrowserError(stale, "stale_ref")).toBe(stale);
  const unsupported = 'this extension build does not support the action "wait" - update the extension from the latest release';
  expect(humanizeBrowserError(unsupported, "unsupported_verb")).toBe(unsupported);
  const noPage = "the agent window has no page yet - navigate to a URL first";
  expect(humanizeBrowserError(noPage, "no_page")).toBe(noPage);
  const nav = "the page navigated away before the remaining steps could run - take a fresh snapshot and retry them";
  expect(humanizeBrowserError(nav, "page_navigated")).toBe(nav);
});
