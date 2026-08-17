import { describe, it, expect } from "vitest";
import { chunkReviewDiff, mergeReviewVerdicts } from "../src/forge/review-chunks.js";
import { DIFF_PROMPT_CAP } from "../src/forge/runs.js";

const CAP = DIFF_PROMPT_CAP;
const fileBlock = (path: string, n: number) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n` + `+x\n`.repeat(n);

describe("chunkReviewDiff", () => {
  it("under the cap -> exactly one chunk, payload is the diff verbatim", () => {
    const diff = "diff --git a/src/x.ts b/src/x.ts\n+hello\n";
    const chunks = chunkReviewDiff(diff, "1 file changed", CAP);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].payload).toBe(diff);
  });

  it("over the cap -> one chunk per directory group, each carrying the whole-diff stat", () => {
    const stat = "STAT-SUMMARY 2 files changed";
    const diff = fileBlock("src/forge/a.ts", 12_000) + fileBlock("app/src/b.ts", 12_000);
    expect(diff.length).toBeGreaterThan(CAP);
    const chunks = chunkReviewDiff(diff, stat, CAP);
    expect(chunks.map((c) => c.group).sort()).toEqual(["app/src", "src/forge"]);
    for (const c of chunks) expect(c.payload).toContain(stat); // mutation check: drop stat -> fails
  });

  it("no chunk payload exceeds the cap", () => {
    const stat = "STAT";
    const diff = fileBlock("src/forge/a.ts", 12_000) + fileBlock("app/src/b.ts", 12_000);
    for (const c of chunkReviewDiff(diff, stat, CAP)) expect(c.payload.length).toBeLessThanOrEqual(CAP);
  });

  it("splits a multi-directory diff into distinct groups even when no single group is truncated", () => {
    const stat = "STAT";
    const diff = fileBlock("src/a/x.ts", 5_000) + fileBlock("src/b/y.ts", 5_000) + fileBlock("tests/z.test.ts", 5_000);
    expect(diff.length).toBeGreaterThan(CAP);
    const chunks = chunkReviewDiff(diff, stat, CAP);
    expect(chunks.map((c) => c.group).sort()).toEqual(["src/a", "src/b", "tests"]);
  });
});

describe("mergeReviewVerdicts", () => {
  const chunk = (group: string) => ({ group, payload: "" });

  it("single chunk passes through the reviewer verdict verbatim", () => {
    const m = mergeReviewVerdicts([chunk("")], ["looks good\nVERDICT: PASS"]);
    expect(m.pass).toBe(true);
    expect(m.raw).toBe("looks good\nVERDICT: PASS");
  });

  it("all chunks pass -> run passes", () => {
    const m = mergeReviewVerdicts([chunk("src/a"), chunk("src/b")], ["VERDICT: PASS", "VERDICT: PASS"]);
    expect(m.pass).toBe(true);
  });

  it("one chunk failing fails the run even when the others pass", () => {
    const m = mergeReviewVerdicts([chunk("src/a"), chunk("src/b")], ["VERDICT: PASS", "bad\nVERDICT: FAIL"]);
    expect(m.pass).toBe(false);
    expect(m.raw).toContain("=== review chunk: src/a ===");
    expect(m.raw).toContain("=== review chunk: src/b ===");
    expect(m.raw).toMatch(/VERDICT:\s*FAIL\s*$/);
  });
});
