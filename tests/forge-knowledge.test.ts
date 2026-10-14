import { describe, it, expect } from "vitest";
import { knowledgeQuery, rankForgeKnowledge } from "../src/forge/runs.js";

describe("knowledgeQuery", () => {
  it("truncates body to 500 characters and joins with title", () => {
    expect(knowledgeQuery({ title: "T", body: "x".repeat(800) })).toBe("T\n" + "x".repeat(500));
  });

  it("returns title only for null, empty, or whitespace-only body", () => {
    expect(knowledgeQuery({ title: "T", body: null })).toBe("T");
    expect(knowledgeQuery({ title: "T", body: undefined })).toBe("T");
    expect(knowledgeQuery({ title: "T", body: "" })).toBe("T");
    expect(knowledgeQuery({ title: "T", body: "   \n\t  " })).toBe("T");
  });

  it("redacts secrets matching redactSecrets patterns in the body", () => {
    const key = "sk-" + "a".repeat(20);
    const q = knowledgeQuery({ title: "Deploy key", body: `use key ${key} ok` });
    expect(q).toContain("[redacted]");
    expect(q).not.toContain(key);
  });
});

describe("rankForgeKnowledge", () => {
  it("ranks non-session sources ahead of sessions while preserving input order within groups", () => {
    const hits = [
      { sourceKind: "session", score: 0.9 },
      { sourceKind: "note", score: 0.8 },
      { sourceKind: "session", score: 0.85 },
      { sourceKind: "vault", score: 0.7 },
      { sourceKind: "repo", score: 0.6 },
      { sourceKind: "session", score: 0.5 },
    ];
    const ranked = rankForgeKnowledge(hits);
    expect(ranked.map((h) => h.sourceKind)).toEqual(["note", "vault", "repo", "session", "session"]);
    expect(ranked.filter((h) => h.sourceKind === "session").map((h) => h.score)).toEqual([0.9, 0.85]);
  });

  it("fills remaining slots with sessions when fewer non-session hits exist, and returns empty for empty input", () => {
    const few = [
      { sourceKind: "note", id: 1 },
      { sourceKind: "session", id: 2 },
      { sourceKind: "session", id: 3 },
    ];
    expect(rankForgeKnowledge(few, 5)).toEqual(few);
    expect(rankForgeKnowledge([], 5)).toEqual([]);
  });
});
