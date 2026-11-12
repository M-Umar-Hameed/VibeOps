import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { buildSdkOptions } from "../src/relay/invoke-sdk.js";

describe("buildSdkOptions executable and stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "sdk-exe-"));

  it("sets pathToClaudeCodeExecutable when the executable exists", () => {
    const exe = join(dir, "claude.exe");
    writeFileSync(exe, "");
    const o: any = buildSdkOptions({}, tmpdir(), false, [], undefined, undefined, { executable: exe });
    expect(o.pathToClaudeCodeExecutable).toBe(exe);
  });

  it("keeps the bundled CLI when the executable is missing or unset", () => {
    const o: any = buildSdkOptions({}, tmpdir(), false, [], undefined, undefined, { executable: join(dir, "missing.exe") });
    expect("pathToClaudeCodeExecutable" in o).toBe(false);
    expect("pathToClaudeCodeExecutable" in buildSdkOptions({}, tmpdir(), false, [])).toBe(false);
  });

  it("forwards prefixed stderr to onData and stops after 4000 characters", () => {
    const chunks: string[] = [];
    const o = buildSdkOptions({}, tmpdir(), false, [], (c) => chunks.push(c));
    o.stderr("a".repeat(3000));
    o.stderr("b".repeat(3000));
    o.stderr("c");
    expect(chunks).toEqual([`[sdk stderr] ${"a".repeat(3000)}`, `[sdk stderr] ${"b".repeat(1000)}`]);
  });
});
