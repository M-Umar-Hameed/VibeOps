import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "vitest";

// The sidecar runs without a console (CREATE_NO_WINDOW). Any child spawned
// without windowsHide gets its own console window on Windows, which flashes
// and steals focus from whatever the user is doing.
// ponytail: the check is line-based; keep the options object on the call line.
const CALL = /\b(?:spawn|spawnSync|execFile|execFileSync|execFileAsync|execSync)\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("every child process spawned by the server hides the Windows console", () => {
  const bad: string[] = [];
  for (const f of walk("src")) {
    readFileSync(f, "utf-8").split("\n").forEach((line, i) => {
      if (!CALL.test(line) || /^\s*(\/\/|\*|import)/.test(line)) return;
      if (!line.includes("windowsHide")) bad.push(`${f}:${i + 1}`);
    });
  }
  expect(bad).toEqual([]);
});
