import { describe, it, expect } from "vitest";
import { styleClause } from "../src/relay/style.js";

describe("styleClause", () => {
  it("returns empty string for off, undefined, null, or garbage", () => {
    expect(styleClause("off")).toBe("");
    expect(styleClause(undefined)).toBe("");
    expect(styleClause(null)).toBe("");
    expect(styleClause("garbage")).toBe("");
  });

  it("returns caveman clause with expected keywords", () => {
    const clause = styleClause("caveman");
    expect(clause).toBeTruthy();
    expect(clause).toMatch(/terse/i);
    expect(clause).toMatch(/substance|exact|identifiers/i);
    // Ensuring it mentions technical substance stays complete
    expect(clause).toMatch(/technical substance/i);
  });

  it("returns humanizer clause with expected keywords", () => {
    const clause = styleClause("humanizer");
    expect(clause).toBeTruthy();
    expect(clause).toMatch(/natural prose/i);
  });
});
