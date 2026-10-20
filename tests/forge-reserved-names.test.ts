import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dropReservedNames } from "../src/forge/sandbox.js";

const raw = (p: string) => (process.platform === "win32" ? `\\\\?\\${p}` : p);

describe("dropReservedNames", () => {
  it("deletes untracked Windows device-name files and keeps real work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-reserved-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      mkdirSync(join(dir, "src"));
      writeFileSync(raw(join(dir, "nul")), "redirected output");
      writeFileSync(raw(join(dir, "src", "aux.log")), "x");
      writeFileSync(join(dir, "src", "null.ts"), "export {};");
      writeFileSync(join(dir, "keep.ts"), "export {};");

      const dropped = await dropReservedNames(dir);

      expect(dropped.sort()).toEqual(["nul", "src/aux.log"]);
      expect(existsSync(raw(join(dir, "nul")))).toBe(false);
      expect(existsSync(raw(join(dir, "src", "aux.log")))).toBe(false);
      expect(existsSync(join(dir, "src", "null.ts"))).toBe(true);
      expect(existsSync(join(dir, "keep.ts"))).toBe(true);
      execFileSync("git", ["add", "-A"], { cwd: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
