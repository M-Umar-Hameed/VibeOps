import { expect, test } from "vitest";
import { stageLabel, parseChecks, elapsedLabel, failureLine, formatStageDurations } from "./run-summary.js";

test("stageLabel maps known stages, falls back otherwise", () => {
  expect(stageLabel("plan")).toBe("Planning the change");
  expect(stageLabel("work")).toBe("Writing and editing code");
  expect(stageLabel("review")).toBe("Reviewing the diff and running checks");
  expect(stageLabel("")).toBe("Starting");
  expect(stageLabel("weird")).toBe("weird");
});

test("parseChecks extracts commands and exit codes from the forge checks block", () => {
  const output =
    "some narration here\n=== FORGE checks ===\n$ npm run typecheck\nexit 0\nall good\n\n$ npm test\nexit 1\n1 failing\n";
  expect(parseChecks(output)).toEqual([
    { command: "npm run typecheck", code: 0 },
    { command: "npm test", code: 1 },
  ]);
});

test("parseChecks returns [] when no checks block present", () => {
  expect(parseChecks("just narration, no checks yet")).toEqual([]);
});

test("elapsedLabel formats seconds and minutes, clamps negatives", () => {
  expect(elapsedLabel(1000, 1000)).toBe("0s");
  expect(elapsedLabel(0, 45_000)).toBe("45s");
  expect(elapsedLabel(0, 125_000)).toBe("2m 5s");
  expect(elapsedLabel(5000, 0)).toBe("0s");
});

test("failureLine is plain-language for terminal failures, null otherwise", () => {
  expect(failureLine("failed")).toMatch(/returned to planned/);
  expect(failureLine("rejected")).toMatch(/blocking issues/);
  expect(failureLine("stopped")).toMatch(/Run stopped/);
  expect(failureLine("error", "token cap exceeded")).toBe("token cap exceeded");
  expect(failureLine("error")).toBe("The run could not be started.");
  expect(failureLine("running")).toBeNull();
  expect(failureLine("passed")).toBeNull();
});

test("formatStageDurations renders a compact one-line minute breakdown in fixed order", () => {
  expect(formatStageDurations({ plan: 420_000, work: 600_000, checks: 120_000, review: 300_000 }))
    .toBe("plan 7m / work 10m / checks 2m / review 5m");
});

test("formatStageDurations skips absent stages and floors sub-minute durations to 1m", () => {
  expect(formatStageDurations({ work: 5_000, review: 12_000 })).toBe("work 1m / review 1m");
  expect(formatStageDurations({})).toBe("");
});
