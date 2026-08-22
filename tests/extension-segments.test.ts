import { describe, it, expect } from "vitest";
import { splitSegments, TAB_VERBS } from "../extension/segments.js";

describe("splitSegments", () => {
  it("keeps a tab-free batch as one page segment", () => {
    const steps = [{ verb: "snapshot" }, { verb: "click", ref: "ref1" }];
    expect(splitSegments(steps)).toEqual([{ kind: "page", steps, start: 0 }]);
  });

  it("splits at tab verbs and records each segment's start index", () => {
    const steps = [
      { verb: "snapshot" },
      { verb: "newTab", url: "https://a.test/" },
      { verb: "snapshot" },
      { verb: "click", ref: "ref1" },
      { verb: "tabs" },
    ];
    expect(splitSegments(steps)).toEqual([
      { kind: "page", steps: [steps[0]], start: 0 },
      { kind: "tab", step: steps[1], start: 1 },
      { kind: "page", steps: [steps[2], steps[3]], start: 2 },
      { kind: "tab", step: steps[4], start: 4 },
    ]);
  });

  it("a batch of only tab verbs has no page segment", () => {
    const steps = [{ verb: "tabs" }, { verb: "switchTab", tabId: 3 }];
    expect(splitSegments(steps).every((s) => s.kind === "tab")).toBe(true);
  });

  it("the verb set matches what the worker handles", () => {
    expect([...TAB_VERBS].sort()).toEqual(["newTab", "switchTab", "tabs"]);
  });
});
