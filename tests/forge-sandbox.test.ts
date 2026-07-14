import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  assertTicketId, sandboxPath, sandboxExists, ensureSandbox,
  forgeCommit, sandboxDiff, promoteSandbox, discardSandbox,
} from "../src/forge/sandbox.js";
import { ConflictError } from "../src/services/errors.js";

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
  writeFileSync(join(workdir, "a.txt"), "hello\n");
  git(workdir, "add", "-A");
  git(workdir, "commit", "-m", "base");
});

afterEach(() => {
  delete process.env.VIBEOPS_SANDBOX_ROOT;
  rmSync(workdir, { recursive: true, force: true });
  rmSync(sandboxRoot, { recursive: true, force: true });
});

describe("forge sandbox", () => {
  it("rejects non-uuid ticket ids", () => {
    expect(() => assertTicketId("../../etc")).toThrow();
    expect(() => assertTicketId(TID)).not.toThrow();
  });

  it("create -> edit -> commit -> diff -> promote merges and cleans up", async () => {
    const sp = await ensureSandbox(workdir, TID);
    expect(sp).toBe(sandboxPath(TID));
    writeFileSync(join(sp, "b.txt"), "new file\n");
    expect(await forgeCommit(TID, "add b")).toBe(true);
    const diff = await sandboxDiff(workdir, TID);
    expect(diff).toContain("b.txt");
    expect(diff).toContain("+new file");
    await promoteSandbox(workdir, TID);
    expect(existsSync(join(workdir, "b.txt"))).toBe(true);
    expect(sandboxExists(TID)).toBe(false);
    expect(git(workdir, "branch", "--list", `forge/${TID}`).trim()).toBe("");
  });

  it("forgeCommit returns false when nothing changed", async () => {
    await ensureSandbox(workdir, TID);
    expect(await forgeCommit(TID, "noop")).toBe(false);
  });

  it("ensureSandbox reuses an existing tree (rework keeps state)", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "wip.txt"), "wip\n");
    const again = await ensureSandbox(workdir, TID);
    expect(again).toBe(sp);
    expect(existsSync(join(sp, "wip.txt"))).toBe(true);
  });

  it("promote refuses a dirty workdir", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "b.txt"), "x\n");
    await forgeCommit(TID, "b");
    writeFileSync(join(workdir, "a.txt"), "dirty\n");
    await expect(promoteSandbox(workdir, TID)).rejects.toThrow(ConflictError);
    expect(sandboxExists(TID)).toBe(true); // sandbox survives refusal
  });

  it("promote aborts cleanly on merge conflict, sandbox kept", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "a.txt"), "sandbox version\n");
    await forgeCommit(TID, "conflict");
    writeFileSync(join(workdir, "a.txt"), "base version\n");
    git(workdir, "add", "-A");
    git(workdir, "commit", "-m", "diverge");
    await expect(promoteSandbox(workdir, TID)).rejects.toThrow(ConflictError);
    expect(git(workdir, "status", "--porcelain").trim()).toBe(""); // merge aborted
    expect(sandboxExists(TID)).toBe(true);
  });

  it("discard removes tree and branch, base repo untouched", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "b.txt"), "x\n");
    await forgeCommit(TID, "b");
    await discardSandbox(workdir, TID);
    expect(sandboxExists(TID)).toBe(false);
    expect(git(workdir, "branch", "--list", `forge/${TID}`).trim()).toBe("");
    expect(existsSync(join(workdir, "b.txt"))).toBe(false);
  });
});
