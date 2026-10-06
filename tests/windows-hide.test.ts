import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "vitest";

// The sidecar runs without a console (CREATE_NO_WINDOW). Any child spawned
// without windowsHide gets its own console window on Windows, which flashes
// and steals focus from whatever the user is doing.
const CALL = /\b(?:spawn|spawnSync|execFile|execFileSync|execFileAsync|execSync)\(/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

// The call's text from its "(" to the matching ")", so options on later lines count.
// ponytail: parens inside string literals are not skipped; fine for spawn arguments.
function callText(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

test("every child process spawned by the server hides the Windows console", () => {
  const bad: string[] = [];
  for (const f of walk("src")) {
    const src = readFileSync(f, "utf-8");
    for (const m of src.matchAll(CALL)) {
      const line = src.slice(src.lastIndexOf("\n", m.index) + 1, m.index);
      if (/^\s*(\/\/|\*|import)/.test(line)) continue;
      if (!callText(src, m.index + m[0].length - 1).includes("windowsHide")) {
        bad.push(`${f}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
  }
  expect(bad).toEqual([]);
});

test("a spawn whose options span several lines is still checked", () => {
  const src = 'spawn("git", ["status"], {\n  cwd,\n  windowsHide: true,\n});';
  expect(callText(src, src.indexOf("("))).toContain("windowsHide");
  expect(callText('spawn("git", ["status"], {\n  cwd,\n});', 5)).not.toContain("windowsHide");
});

// Source must be UTF-8: Node decodes it as such, so a stray Windows-1252 byte
// reaches prompts and UI as U+FFFD.
test("every source file is valid UTF-8", () => {
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const bad = [...walk("src"), ...walk("tests")].filter((f) => {
    try { utf8.decode(readFileSync(f)); return false; } catch { return true; }
  });
  expect(bad).toEqual([]);
});
