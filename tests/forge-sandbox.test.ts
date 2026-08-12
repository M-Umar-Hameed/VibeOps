import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, rmdirSync, readFileSync, readlinkSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  assertTicketId, sandboxPath, sandboxExists, ensureSandbox, branchName,
  forgeCommit, sandboxDiff, sandboxDiffSummary, promoteSandbox, discardSandbox,
  unlinkDeps, hasCommitsToPromote, sandboxActivity, sandboxWorkingDiff,
  snapshotDeps, detectDepsLeak, listSandboxTicketIds, sandboxSizeBytes
} from "../src/forge/sandbox.js";
import { ConflictError } from "../src/services/errors.js";

const TID = "11111111-2222-3333-4444-555555555555";
const TID2 = "22222222-3333-4444-5555-666666666666";

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
  writeFileSync(join(workdir, ".gitignore"), "node_modules/\n");
  mkdirSync(join(workdir, "node_modules"));
  writeFileSync(join(workdir, "node_modules", "marker.txt"), "base-marker\n");
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
    await promoteSandbox(workdir, TID, "add b file");
    expect(existsSync(join(workdir, "b.txt"))).toBe(true);
    expect(sandboxExists(TID)).toBe(false);
    expect(git(workdir, "branch", "--list", `forge/${TID}`).trim()).toBe("");
  });

  it("sandboxDiffSummary returns a --stat style line for a changed file", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "b.txt"), "new file\n");
    await forgeCommit(TID, "add b");
    const stat = await sandboxDiffSummary(workdir, TID);
    expect(stat).toContain("b.txt");
    expect(stat).toMatch(/\d+ files? changed/);
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
    await expect(promoteSandbox(workdir, TID, "dirty workdir")).rejects.toThrow(ConflictError);
    expect(sandboxExists(TID)).toBe(true); // sandbox survives refusal
  });

  it("promote aborts cleanly on merge conflict, sandbox kept", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "a.txt"), "sandbox version\n");
    await forgeCommit(TID, "conflict");
    writeFileSync(join(workdir, "a.txt"), "base version\n");
    git(workdir, "add", "-A");
    git(workdir, "commit", "-m", "diverge");
    await expect(promoteSandbox(workdir, TID, "conflict ticket")).rejects.toThrow(ConflictError);
    expect(git(workdir, "status", "--porcelain").trim()).toBe(""); // merge aborted
    expect(sandboxExists(TID)).toBe(true);
  });

  it("promote conflict message names the conflicting file, sandbox and branch intact", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "a.txt"), "sandbox version\n");
    await forgeCommit(TID, "conflict");
    writeFileSync(join(workdir, "a.txt"), "base version\n");
    git(workdir, "add", "-A");
    git(workdir, "commit", "-m", "diverge");

    let err: any;
    try { await promoteSandbox(workdir, TID, "conflict ticket"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toContain("a.txt");
    expect(err.message).toContain("conflicts with the base");
    // Sandbox still exists after the failed promote
    expect(sandboxExists(TID)).toBe(true);
    // Branch still exists and has commits
    expect(git(workdir, "rev-parse", `forge/${TID}`).trim()).toBeTruthy();
    expect(await hasCommitsToPromote(workdir, TID)).toBe(true);
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

  it("ensureSandbox links base node_modules into the sandbox", async () => {
    const sp = await ensureSandbox(workdir, TID);
    const marker = join(sp, "node_modules", "marker.txt");
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf-8")).toBe(
      readFileSync(join(workdir, "node_modules", "marker.txt"), "utf-8")
    );
  });

  it("SAFETY: cleanup unlinks deps before removing the worktree, base node_modules survives", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "b.txt"), "x\n");
    await forgeCommit(TID, "b");
    await discardSandbox(workdir, TID);
    expect(sandboxExists(TID)).toBe(false);
    expect(existsSync(join(workdir, "node_modules", "marker.txt"))).toBe(true);

    // same guarantee via promoteSandbox on a second ticket
    const sp2 = await ensureSandbox(workdir, TID2);
    writeFileSync(join(sp2, "c.txt"), "y\n");
    await forgeCommit(TID2, "c");
    await promoteSandbox(workdir, TID2, "add c file");
    expect(sandboxExists(TID2)).toBe(false);
    expect(existsSync(join(workdir, "node_modules", "marker.txt"))).toBe(true);
  });

  it("SAFETY: cleanup throws if a junction survives unlinkDeps, base node_modules intact", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "b.txt"), "x\n");
    await forgeCommit(TID, "b");

    // Break the worktree so `git worktree remove` fails and leaves the directory,
    // which is required to trigger the `existsSync(path)` guard in cleanup.
    rmSync(join(sp, ".git"), { recursive: true, force: true });

    // Start discardSandbox. It synchronously calls unlinkDeps, which removes the junction,
    // then it yields the event loop at `await git(...)`.
    const promise = discardSandbox(workdir, TID);

    // While discardSandbox is awaiting git, recreate the junction.
    // This simulates unlinkDeps failing or missing the junction.
    symlinkSync(join(workdir, "node_modules"), join(sp, "node_modules"), process.platform === "win32" ? "junction" : "dir");

    // discardSandbox resumes, checks existsSync(path) (true, since git failed),
    // finds the junction, and throws.
    await expect(promise).rejects.toThrow(/refusing recursive cleanup/);

    // Most importantly, the base node_modules must survive.
    expect(existsSync(join(workdir, "node_modules", "marker.txt"))).toBe(true);
  });

  it("forgeCommit does not stage the linked node_modules (gitignored)", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "b.txt"), "x\n");
    expect(await forgeCommit(TID, "b")).toBe(true);
    const tree = git(sp, "ls-tree", "-r", "--name-only", branchName(TID));
    expect(tree).not.toContain("node_modules");
  });

  it("unlinkDeps on a real node_modules directory leaves it untouched; cleanup still works", async () => {
    const sp = await ensureSandbox(workdir, TID);
    // simulate a sandbox where node_modules is a REAL directory, not a link
    // Drop the link the same way production does. rmdir removes a Windows junction
    // but throws ENOTDIR on a POSIX symlink, so this setup step is itself platform-
    // dependent — the same defect the code under test had.
    unlinkDeps(TID);
    mkdirSync(join(sp, "node_modules"));
    writeFileSync(join(sp, "node_modules", "real.txt"), "real\n");

    unlinkDeps(TID);
    expect(existsSync(join(sp, "node_modules", "real.txt"))).toBe(true);

    await discardSandbox(workdir, TID);
    expect(sandboxExists(TID)).toBe(false);
    expect(existsSync(join(workdir, "node_modules", "marker.txt"))).toBe(true);
  });

  it("hasCommitsToPromote is false for a fresh sandbox with no work commit, true after one", async () => {
    await ensureSandbox(workdir, TID);
    expect(await hasCommitsToPromote(workdir, TID)).toBe(false);
    const sp = sandboxPath(TID);
    writeFileSync(join(sp, "b.txt"), "x\n");
    await forgeCommit(TID, "b");
    expect(await hasCommitsToPromote(workdir, TID)).toBe(true);
  });

  it("sandboxActivity reports committed and uncommitted changes vs the base branch", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "b.txt"), "line1\nline2\n"); // new file
    await forgeCommit(TID, "add b"); // committed
    writeFileSync(join(sp, "a.txt"), "goodbye\n"); // uncommitted edit (was "hello\n")

    const activity = await sandboxActivity(workdir, TID);
    const byPath = Object.fromEntries(activity.files.map(f => [f.path, f]));
    expect(byPath["b.txt"]).toEqual({ path: "b.txt", status: "A", additions: 2, deletions: 0 });
    expect(byPath["a.txt"]).toEqual({ path: "a.txt", status: "M", additions: 1, deletions: 1 });
    expect(activity.totalAdditions).toBe(3);
    expect(activity.totalDeletions).toBe(1);
  });

  it("sandboxActivity caches for ~2s: a file written after the first call is invisible to the second", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "b.txt"), "x\n");
    const first = await sandboxActivity(workdir, TID);
    writeFileSync(join(sp, "c.txt"), "y\n");
    const second = await sandboxActivity(workdir, TID);
    expect(second).toEqual(first);
  });

  it("sandboxWorkingDiff includes uncommitted changes, unlike sandboxDiff", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "a.txt"), "uncommitted edit\n");
    expect(await sandboxDiff(workdir, TID)).not.toContain("uncommitted edit");
    expect(await sandboxWorkingDiff(workdir, TID)).toContain("uncommitted edit");
  });

  it("diff is computed against the sandbox base, not a moving master (BUG2)", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "b.txt"), "sandbox line\n"); // the agent's only change
    await forgeCommit(TID, "add b");

    // master advances DURING the run: a new commit touching an unrelated file.
    writeFileSync(join(workdir, "master-added.txt"), "supervisor fix\n");
    git(workdir, "add", "-A");
    git(workdir, "commit", "-m", "supervisor commit while run in progress");

    const activity = await sandboxActivity(workdir, TID);
    const paths = activity.files.map((f) => f.path);
    expect(paths).toContain("b.txt");
    expect(paths).not.toContain("master-added.txt"); // must NOT appear as a deletion
    expect(activity.totalDeletions).toBe(0);

    const diff = await sandboxWorkingDiff(workdir, TID);
    expect(diff).toContain("b.txt");
    expect(diff).not.toContain("master-added.txt");
  });

  async function promoteAndReadMsg(tid: string, title: string): Promise<{ subject: string; body: string }> {
    const sp = await ensureSandbox(workdir, tid);
    writeFileSync(join(sp, `${tid}.txt`), "x\n");
    await forgeCommit(tid, "work");
    await promoteSandbox(workdir, tid, title);
    const subject = git(workdir, "log", "-1", "--format=%s").trim();
    const body = git(workdir, "log", "-1", "--format=%b").trim();
    return { subject, body };
  }

  it("promote subject carries the ticket title, id stays findable in the body", async () => {
    const { subject, body } = await promoteAndReadMsg(TID, "Fix the flaky auth test");
    expect(subject).toContain("Fix the flaky auth test");
    expect(subject).not.toBe(`forge: promote ${TID}`);
    expect(body).toContain(TID);
  });

  it("very long title yields a sane subject with the full title in the body", async () => {
    const long = "A".repeat(200);
    const { subject, body } = await promoteAndReadMsg(TID, long);
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(subject.endsWith("...")).toBe(true);
    expect(body).toContain(long); // full, untruncated
    expect(body).toContain(TID);
  });

  it("redacts a secret-shaped string in the promote message", async () => {
    const secret = "sk-abcdef0123456789ABCDEF";
    const { subject, body } = await promoteAndReadMsg(TID, `leak ${secret}`);
    expect(subject).not.toContain(secret);
    expect(body).not.toContain(secret);
    expect(`${subject}\n${body}`).toContain("[redacted]");
  });

  it("promote with discardAfter=false merges but KEEPS the sandbox and branch", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "b.txt"), "new file\n");
    await forgeCommit(TID, "add b");
    await promoteSandbox(workdir, TID, "add b file", false);
    expect(existsSync(join(workdir, "b.txt"))).toBe(true);      // merge still landed
    expect(sandboxExists(TID)).toBe(true);                       // sandbox kept
    expect(git(workdir, "rev-parse", `forge/${TID}`).trim()).toBeTruthy(); // branch kept
  });

  it("cleanup deletes a real (non-link) app/node_modules copy, base app/node_modules survives", async () => {
    mkdirSync(join(workdir, "app", "node_modules"), { recursive: true });
    writeFileSync(join(workdir, "app", "node_modules", "app-marker.txt"), "app-base\n");
    const sp = await ensureSandbox(workdir, TID, true); // frontendDeps: real copy
    expect(() => readlinkSync(join(sp, "app", "node_modules"))).toThrow(); // real dir, not link
    writeFileSync(join(sp, "b.txt"), "x\n");
    await forgeCommit(TID, "b");
    await discardSandbox(workdir, TID);
    expect(sandboxExists(TID)).toBe(false);                                    // real copy gone
    expect(existsSync(join(workdir, "app", "node_modules", "app-marker.txt"))).toBe(true); // base intact
    expect(existsSync(join(workdir, "node_modules", "marker.txt"))).toBe(true);            // base root intact
  });

  it("listSandboxTicketIds returns created sandboxes and ignores non-uuid dirs", async () => {
    await ensureSandbox(workdir, TID);
    mkdirSync(join(sandboxRoot, "not-a-uuid"));
    const ids = listSandboxTicketIds();
    expect(ids).toContain(TID);
    expect(ids).not.toContain("not-a-uuid");
  });

  it("sandboxSizeBytes counts sandbox files but not the base node_modules junction", async () => {
    const sp = await ensureSandbox(workdir, TID);            // node_modules is a junction here
    writeFileSync(join(sp, "big.txt"), "y".repeat(5000));
    const size = sandboxSizeBytes(TID);
    expect(size).toBeGreaterThanOrEqual(5000);
    // base node_modules marker (via junction) must NOT be counted
    expect(size).toBeLessThan(50_000);
  });
});

describe("deps leak guard", () => {
  it("clean case: snapshotDeps then no changes returns empty detectDepsLeak", () => {
    const baseline = snapshotDeps(workdir);
    const leaked = detectDepsLeak(baseline);
    expect(leaked).toEqual([]);
  });

  it("addition case: new file in node_modules is reverted and reported", () => {
    const baseline = snapshotDeps(workdir);
    const evilPath = join(workdir, "node_modules", "EVIL.txt");
    writeFileSync(evilPath, "bad\n");
    const leaked = detectDepsLeak(baseline);
    expect(leaked.length).toBe(1);
    expect(leaked[0]).toContain("EVIL.txt");
    expect(leaked[0]).toContain("added; reverted");
    expect(existsSync(evilPath)).toBe(false);
  });

  it("modification case: touching existing file reports modified, file still exists", () => {
    const baseline = snapshotDeps(workdir);
    const markerPath = join(workdir, "node_modules", "marker.txt");
    // Bump mtime by writing new content
    writeFileSync(markerPath, "modified content\n");
    const leaked = detectDepsLeak(baseline);
    expect(leaked.length).toBe(1);
    expect(leaked[0]).toContain("marker.txt");
    expect(leaked[0]).toContain("(modified)");
    expect(existsSync(markerPath)).toBe(true);
  });
});

describe("frontend deps mode", () => {
  it("frontendDeps: app/node_modules is a real copy, vite temp writes stay out of the base", async () => {
    // base app/node_modules with a marker (beforeEach only builds root node_modules)
    mkdirSync(join(workdir, "app", "node_modules"), { recursive: true });
    writeFileSync(join(workdir, "app", "node_modules", "app-marker.txt"), "app-base\n");

    const baseline = snapshotDeps(workdir);
    const sp = await ensureSandbox(workdir, TID, true);

    // copy landed and is NOT a link
    expect(readFileSync(join(sp, "app", "node_modules", "app-marker.txt"), "utf-8")).toBe("app-base\n");
    expect(() => readlinkSync(join(sp, "app", "node_modules"))).toThrow();

    // simulate vite's config-loader .vite-temp write into the sandbox copy
    mkdirSync(join(sp, "app", "node_modules", ".vite-temp"), { recursive: true });
    writeFileSync(join(sp, "app", "node_modules", ".vite-temp", "cfg.mjs"), "x\n");

    // base app/node_modules is untouched: no .vite-temp, guard sees no leak
    expect(existsSync(join(workdir, "app", "node_modules", ".vite-temp"))).toBe(false);
    expect(detectDepsLeak(baseline)).toEqual([]);

    // cleanup removes the sandbox copy, base survives
    await discardSandbox(workdir, TID);
    expect(existsSync(join(workdir, "app", "node_modules", "app-marker.txt"))).toBe(true);
    expect(existsSync(join(workdir, "app", "node_modules", ".vite-temp"))).toBe(false);
  });

  it("frontendDeps on: a genuine write into the linked ROOT node_modules is still detected and reverted", async () => {
    await ensureSandbox(workdir, TID, true); // root node_modules still junctioned
    const sp = sandboxPath(TID);
    const baseline = snapshotDeps(workdir);

    // write through the sandbox's root node_modules junction into the base
    const evil = join(sp, "node_modules", "EVIL.txt");
    writeFileSync(evil, "leak\n");
    expect(existsSync(join(workdir, "node_modules", "EVIL.txt"))).toBe(true); // reached base via junction

    const leaked = detectDepsLeak(baseline);
    expect(leaked.length).toBe(1);
    expect(leaked[0]).toContain("EVIL.txt");
    expect(leaked[0]).toContain("added; reverted");
    expect(existsSync(join(workdir, "node_modules", "EVIL.txt"))).toBe(false); // reverted
  });

  it("enabling frontendDeps on an existing OFF sandbox converts the junction to a real copy; base untouched", async () => {
    // base app/node_modules (beforeEach only builds root node_modules)
    mkdirSync(join(workdir, "app", "node_modules"), { recursive: true });
    writeFileSync(join(workdir, "app", "node_modules", "app-marker.txt"), "app-base\n");
    const baseAppDeps = join(workdir, "app", "node_modules");
    const baseEntriesBefore = readdirSync(baseAppDeps).sort();

    // 1. create sandbox with frontendDeps OFF -> app/node_modules is a junction
    const sp = await ensureSandbox(workdir, TID, false);
    expect(readlinkSync(join(sp, "app", "node_modules"))).toBeTruthy(); // is a link

    // 2. enable the setting and re-run ensureSandbox on the SAME tree
    const again = await ensureSandbox(workdir, TID, true);
    expect(again).toBe(sp);

    // 3. app/node_modules is now a real directory, not a reparse point
    expect(() => readlinkSync(join(sp, "app", "node_modules"))).toThrow();
    expect(readFileSync(join(sp, "app", "node_modules", "app-marker.txt"), "utf-8")).toBe("app-base\n");

    // 4. BASE app/node_modules is byte-identical: same entries, same marker content
    expect(readdirSync(baseAppDeps).sort()).toEqual(baseEntriesBefore);
    expect(readFileSync(join(baseAppDeps, "app-marker.txt"), "utf-8")).toBe("app-base\n");

    // 5. root node_modules stays a link across both modes
    expect(readlinkSync(join(sp, "node_modules"))).toBeTruthy();

    // writes into the converted copy do not reach the base
    mkdirSync(join(sp, "app", "node_modules", ".vite-temp"), { recursive: true });
    writeFileSync(join(sp, "app", "node_modules", ".vite-temp", "cfg.mjs"), "x\n");
    expect(existsSync(join(baseAppDeps, ".vite-temp"))).toBe(false);
  });

  it("root node_modules stays a link in both OFF and ON modes", async () => {
    mkdirSync(join(workdir, "app", "node_modules"), { recursive: true });
    writeFileSync(join(workdir, "app", "node_modules", "app-marker.txt"), "app-base\n");

    const sp = await ensureSandbox(workdir, TID, false);
    expect(readlinkSync(join(sp, "node_modules"))).toBeTruthy(); // OFF: link

    await ensureSandbox(workdir, TID, true);
    expect(readlinkSync(join(sp, "node_modules"))).toBeTruthy(); // ON: still link
  });
});

describe("range helpers", () => {
  it("sandboxRangePatch shows a secret added then redacted in a later commit", async () => {
    const sp = await ensureSandbox(workdir, TID);
    const secret = "Bearer " + "a".repeat(30);
    // commit1: add secret
    writeFileSync(join(sp, "config.txt"), secret + "\n");
    await forgeCommit(TID, "add secret");
    // commit2: redact it
    writeFileSync(join(sp, "config.txt"), "[redacted]\n");
    await forgeCommit(TID, "redact secret");

    const { sandboxRangePatch } = await import("../src/forge/sandbox.js");
    const patch = await sandboxRangePatch(workdir, TID);
    expect(patch).toContain("+" + secret); // added line visible in the patch
  });

  it("sandboxDiffNameStatus returns correct A/M/D entries", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "b.txt"), "new\n"); // A
    writeFileSync(join(sp, "a.txt"), "modified\n"); // M
    await forgeCommit(TID, "changes");

    const { sandboxDiffNameStatus } = await import("../src/forge/sandbox.js");
    const ns = await sandboxDiffNameStatus(workdir, TID);
    expect(ns.find(e => e.path === "b.txt")?.status).toBe("A");
    expect(ns.find(e => e.path === "a.txt")?.status).toBe("M");
  });

  it("sandboxCheckout reverts and restores MODIFIED files", async () => {
    const sp = await ensureSandbox(workdir, TID);
    // Modify existing file (not add new one)
    writeFileSync(join(sp, "a.txt"), "modified content\n");
    await forgeCommit(TID, "modify a");

    const { sandboxBaseCommit, sandboxCheckout } = await import("../src/forge/sandbox.js");
    const base = await sandboxBaseCommit(workdir, TID);
    // revert to base
    await sandboxCheckout(TID, base, ["a.txt"]);
    expect(readFileSync(join(sp, "a.txt"), "utf-8").trim()).toBe("hello"); // original content
    // restore HEAD
    await sandboxCheckout(TID, "HEAD", ["a.txt"]);
    expect(readFileSync(join(sp, "a.txt"), "utf-8").trim()).toBe("modified content");
  });

  it("sandboxDeletePaths removes added files for mutation probe", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "new.txt"), "new content\n");
    await forgeCommit(TID, "add new");

    const { sandboxDeletePaths, sandboxCheckout } = await import("../src/forge/sandbox.js");
    // delete added file
    await sandboxDeletePaths(TID, ["new.txt"]);
    expect(existsSync(join(sp, "new.txt"))).toBe(false);
    // restore from HEAD
    await sandboxCheckout(TID, "HEAD", ["new.txt"]);
    expect(readFileSync(join(sp, "new.txt"), "utf-8").trim()).toBe("new content");
  });
});
