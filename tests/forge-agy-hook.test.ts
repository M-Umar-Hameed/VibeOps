import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installAgyHook, restoreAgyHook, AGY_HOOK_NAME, needsAgyHook, withAgyHook } from "../src/forge/agy-hook.js";
import { templates } from "../src/relay/bootstrap-config.js";
import { ensureSandbox, forgeCommit, sandboxPath } from "../src/forge/sandbox.js";

const TID = "11111111-2222-3333-4444-555555555555";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

let workdir: string;
let sandboxRoot: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "forge-base-"));
  sandboxRoot = mkdtempSync(join(tmpdir(), "forge-sbx-"));
  process.env.VIBEOPS_SANDBOX_ROOT = sandboxRoot;
  git(workdir, "init", "-b", "main");
  git(workdir, "config", "user.email", "t@t");
  git(workdir, "config", "user.name", "t");
  git(workdir, "config", "core.autocrlf", "false");
  writeFileSync(join(workdir, "a.txt"), "hello\n");
  writeFileSync(join(workdir, ".gitignore"), "node_modules/\n");
  git(workdir, "add", "-A");
  git(workdir, "commit", "-m", "base");
});

afterEach(() => {
  delete process.env.VIBEOPS_SANDBOX_ROOT;
  rmSync(workdir, { recursive: true, force: true });
  rmSync(sandboxRoot, { recursive: true, force: true });
});

describe("forge agy-hook install and restore", () => {
  it("installs hook into fresh sandbox", async () => {
    const sp = await ensureSandbox(workdir, TID);
    installAgyHook(sp, "dummy-command");
    const hookFile = join(sp, ".agents", "hooks.json");
    expect(existsSync(hookFile)).toBe(true);
    const parsed = JSON.parse(readFileSync(hookFile, "utf-8")) as {
      [key: string]: { PreToolUse: { matcher: string; hooks: { type: string; command: string; timeout: number }[] }[] };
    };
    expect(parsed[AGY_HOOK_NAME].PreToolUse[0].matcher).toBe("run_command");
    expect(parsed[AGY_HOOK_NAME].PreToolUse[0].hooks[0]).toEqual({
      type: "command",
      command: "dummy-command",
      timeout: 10,
    });
  });

  it("removes hook before forgeCommit on fresh sandbox leaving no trace in committed tree or disk", async () => {
    const sp = await ensureSandbox(workdir, TID);
    installAgyHook(sp, "dummy-command");
    writeFileSync(join(sp, "b.txt"), "change\n");
    const committed = await forgeCommit(TID, "test change");
    expect(committed).toBe(true);
    const files = git(sp, "ls-tree", "-r", "--name-only", "HEAD");
    expect(files).not.toContain(".agents/hooks.json");
    expect(files).not.toContain(".forge/agy-hook-backup.json");
    expect(existsSync(join(sp, ".agents"))).toBe(false);
  });

  it("restores pre-existing tracked .agents/hooks.json byte for byte", async () => {
    const origBytes = Buffer.from('{"other":{"PreToolUse":[]}}\r\n', "utf-8");
    mkdirSync(join(workdir, ".agents"), { recursive: true });
    writeFileSync(join(workdir, ".agents", "hooks.json"), origBytes);
    git(workdir, "add", "-A");
    git(workdir, "commit", "-m", "add tracked hooks.json");

    const sp = await ensureSandbox(workdir, TID);
    installAgyHook(sp, "dummy-command");

    const hookFile = join(sp, ".agents", "hooks.json");
    const parsed = JSON.parse(readFileSync(hookFile, "utf-8")) as Record<string, unknown>;
    expect(parsed.other).toBeDefined();
    expect(parsed[AGY_HOOK_NAME]).toBeDefined();

    restoreAgyHook(sp);
    const committed = await forgeCommit(TID, "no changes");
    expect(committed).toBe(false);
    expect(readFileSync(hookFile)).toEqual(origBytes);
  });

  it("installing twice and restoring once restores original bytes", async () => {
    const origBytes = Buffer.from('{"initial":1}\n', "utf-8");
    mkdirSync(join(workdir, ".agents"), { recursive: true });
    writeFileSync(join(workdir, ".agents", "hooks.json"), origBytes);
    git(workdir, "add", "-A");
    git(workdir, "commit", "-m", "add tracked hooks.json");

    const sp = await ensureSandbox(workdir, TID);
    installAgyHook(sp, "cmd-1");
    installAgyHook(sp, "cmd-2");

    restoreAgyHook(sp);
    expect(readFileSync(join(sp, ".agents", "hooks.json"))).toEqual(origBytes);
  });

  it("restoreAgyHook with no backup is a no-op, and forgeCommit without install is unchanged", async () => {
    const sp = await ensureSandbox(workdir, TID);
    expect(() => restoreAgyHook(sp)).not.toThrow();
    writeFileSync(join(sp, "b.txt"), "hello\n");
    const committed = await forgeCommit(TID, "normal commit");
    expect(committed).toBe(true);
    expect(git(sp, "ls-tree", "-r", "--name-only", "HEAD")).toContain("b.txt");
  });
});
