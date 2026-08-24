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
