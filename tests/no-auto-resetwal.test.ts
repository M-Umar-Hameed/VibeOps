import { expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

function walkDir(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkDir(full));
    else if (entry.name.endsWith(".ts")) results.push(full);
  }
  return results;
}

test("resetwal is never wired to a process spawn in src", async () => {
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));
  const files = walkDir(srcDir);
  const exec = /(child_process|execSync|spawnSync|spawn|exec)\(/;
  for (const f of files) {
    const text = readFileSync(f, "utf-8");
    if (!/resetwal/i.test(text)) continue;
    // resetwal may appear only in user-facing strings/comments, never near a spawn.
    for (const line of text.split("\n")) {
      if (/resetwal/i.test(line)) expect(exec.test(line)).toBe(false);
    }
  }
});
