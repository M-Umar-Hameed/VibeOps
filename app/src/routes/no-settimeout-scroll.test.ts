import { expect, test } from "vitest";
import { readFileSync } from "node:fs";

const files = [
  "src/routes/forge.tsx",
  "src/routes/chat.tsx",
  "src/routes/create.tsx",
];

test("no setTimeout-based scroll remains in the three routes", () => {
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    // any setTimeout whose body touches scrollTop/scrollHeight
    const offenders = src.match(/setTimeout\([^]*?scroll(Top|Height)/g) ?? [];
    expect(offenders, `${f} still has setTimeout scroll`).toEqual([]);
  }
});

test("output state is chunk arrays, not concatenated strings", () => {
  expect(readFileSync("src/routes/forge.tsx", "utf8")).not.toMatch(/setRunOutput\(prev => prev \+/);
  expect(readFileSync("src/routes/chat.tsx", "utf8")).not.toMatch(/setLiveOutput\(\(prev\) => prev \+/);
  expect(readFileSync("src/routes/create.tsx", "utf8")).not.toMatch(/setCouncilOutput\(prev => prev \+/);
});
