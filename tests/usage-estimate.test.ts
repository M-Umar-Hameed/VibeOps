import { describe, it, expect } from "vitest";
import { estimateTokens } from "../src/services/usage.js";

describe("estimateTokens", () => {
  it("counts the prompt, not just the output", () => {
    // The bug this guards: the estimate used outputChars alone, so a 40k-char plan
    // prompt answered in 400 chars was billed as 100 tokens against the budget cap.
    expect(estimateTokens(40_000, 400)).toBe(10_100);
    expect(estimateTokens(40_000, 400)).toBeGreaterThan(estimateTokens(0, 400));
  });

  it("treats a missing prompt length as zero rather than NaN", () => {
    expect(estimateTokens(undefined, 400)).toBe(100);
  });
});
