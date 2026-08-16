import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readlinkSync, rmdirSync, unlinkSync, symlinkSync, statSync, readdirSync, rmSync, cpSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ConflictError } from "../services/errors.js";
import { redactSecrets } from "./redact.js";
import { vibeopsHome } from "../runtime/home.js";

// Candidate deps dirs to link from the base repo into a sandbox, so work agents
// (fresh worktree, no install) can run tests without a full npm install per ticket.
const DEPS_DIRS = ["node_modules", join("app", "node_modules")];
const APP_DEPS = join("app", "node_modules");

const DIFF_CAP = 150_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertTicketId(id: string): void {
  if (!UUID.test(id)) throw new Error(`invalid ticket id "${id}"`);
}

function sandboxRoot(): string {
  return process.env.VIBEOPS_SANDBOX_ROOT ?? join(vibeopsHome(), ".vibeops", "sandbox");
}

export function sandboxPathIn(root: string, ticketId: string): string {
  assertTicketId(ticketId);
  return join(root, ticketId);
}

export function sandboxPath(ticketId: string): string {
  return sandboxPathIn(sandboxRoot(), ticketId);
}

export function branchName(ticketId: string): string {
  assertTicketId(ticketId);
  return `forge/${ticketId}`;
}

export function sandboxExists(ticketId: string): boolean {
  return existsSync(sandboxPath(ticketId));
}

// True if the on-disk sandbox is a live git worktree (has a `.git` file linking
// it to the base repo). An orphan left by a failed removal (partial tree missing
// .git) or an interrupted run (empty dir) has none. Cheap discriminator so the
// backlog sweep can skip a directory git has no record of instead of running
// worktree commands against it and aborting.
export function isLiveWorktree(ticketId: string): boolean {
  return existsSync(join(sandboxPath(ticketId), ".git"));
}

// On-disk sandbox ticket ids (UUID-named dirs under the sandbox root). Used by the
// manual backlog-cleanup pass. Missing root => [].
export function listSandboxTicketIds(): string[] {
  try {
    return readdirSync(sandboxRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && UUID.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// Real bytes a discard would reclaim: sum of file sizes under the sandbox, NEVER
// descending a junction/symlink (readlink succeeds). Skipping links excludes the
// shared root node_modules junction (counted once in the base, not reclaimed) and
// still counts a real frontendDeps app/node_modules copy (genuinely reclaimed).
export function sandboxSizeBytes(ticketId: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (isLink(full)) continue;
      if (e.isDirectory()) walk(full);
      else { try { total += statSync(full).size; } catch { /* vanished mid-walk */ } }
    }
  };
  walk(sandboxPath(ticketId));
  return total;
}

// Delete an orphan sandbox dir (no .git, git has no record) and return bytes
// reclaimed -- ONLY if no reparse point exists anywhere inside; returns null if a
// link is found, so the caller leaves and reports it. The recursive link scan IS the
// guard: a forced recursive delete once followed a node_modules junction into the
// base repo and destroyed it. lstat/readlink every entry, never descend a link.
export function deleteOrphanIfLinkFree(ticketId: string): number | null {
  const root = sandboxPath(ticketId);
  let bytes = 0;
  const scan = (dir: string): boolean => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (isLink(full)) return true;
      if (e.isDirectory()) { if (scan(full)) return true; }
      else { try { bytes += statSync(full).size; } catch { /* vanished mid-walk */ } }
    }
    return false;
  };
  if (scan(root)) return null;
  rmSync(root, { recursive: true, force: true });
  return bytes;
}

// Arg-vector git, never shell. Returns code+combined output; callers decide what's fatal.
function git(cwd: string, ...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const cap = (d: Buffer) => { if (out.length < DIFF_CAP) out += d.toString("utf-8"); };
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    child.on("close", (code) => resolve({ code: code ?? 1, out: out.slice(0, DIFF_CAP) }));
    child.on("error", (e) => resolve({ code: 1, out: String(e) }));
  });
}

async function must(cwd: string, ...args: string[]): Promise<string> {
  const { code, out } = await git(cwd, ...args);
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${out.trim()}`);
  return out;
}

// True if p is a junction/symlink (readlink succeeds), false for a real dir or missing path.
function isLink(p: string): boolean {
  try { readlinkSync(p); return true; } catch { return false; }
}

// Link (or copy, when frontendDeps) base repo deps into the sandbox.
// Never throws — a missing/failed link just means the work agent can't run tests, not a broken sandbox.
export function linkDeps(workdir: string, ticketId: string, frontendDeps = false): void {
  const sbx = sandboxPath(ticketId);
  for (const rel of DEPS_DIRS) {
    const src = resolve(join(workdir, rel));
    const dest = join(sbx, rel);
    if (!existsSync(src)) continue;
    if (existsSync(dest)) {
      // Reconcile an existing dest with the current mode. Only app/node_modules
      // converts: frontendDeps wants a real copy, but an earlier off-mode run left
      // a junction. Drop the junction (link-safe rmdir, never a recursive delete)
      // so the copy branch below runs. An off-mode real copy is left as-is -- a
      // copy never leaks, and deleting it for disk isn't worth the risk here.
      if (!(frontendDeps && rel === APP_DEPS && isLink(dest))) continue;
      try { dropLink(dest); } catch (e) {
        console.warn(`linkDeps: failed to unlink ${rel} for reconcile: ${String(e)}`);
        continue;
      }
    }
    try {
      mkdirSync(dirname(dest), { recursive: true });
      if (frontendDeps && rel === APP_DEPS) {
        // Real per-sandbox copy (deref links) so vite's config-loader ".vite-temp"
        // and any tool cache write lands here, not through a junction into the base.
        // ponytail: full deref copy -- disk-hungry, paid only when forge.frontendDeps
        // is set. Upgrade path: per-package junction overlay if disk ever bites.
        cpSync(src, dest, { recursive: true, dereference: true });
      } else {
        symlinkSync(src, dest, process.platform === "win32" ? "junction" : "dir");
      }
    } catch (e) {
      console.warn(`linkDeps: failed to link ${rel}: ${String(e)}`);
    }
  }
}

// Remove only the links created by linkDeps, never a real directory.
// Detection: readlink succeeds on junctions/symlinks, throws (EINVAL/ENOENT) on real dirs or missing paths.
export function unlinkDeps(ticketId: string): void {
  const sbx = sandboxPath(ticketId);
  for (const rel of DEPS_DIRS) {
    const dest = join(sbx, rel);
    try {
      readlinkSync(dest);
      dropLink(dest);
    } catch {
      // not a link (real dir, or doesn't exist) — leave it alone
    }
  }
}

// Removing the LINK, not its target, needs a different call per platform: a Windows
// junction is a directory (rmdir), a POSIX symlink is not (unlink, and rmdir on one
// fails ENOTDIR). The old code used rmdir everywhere, which worked on Windows and
// left every sandbox link in place on Linux — the cause of the ENOTDIR and EEXIST
// failures, and of base node_modules being destroyed when cleanup fell through to a
// recursive delete.
function dropLink(dest: string): void {
  if (process.platform === "win32") rmdirSync(dest);
  else unlinkSync(dest);
}

export async function ensureSandbox(workdir: string, ticketId: string, frontendDeps = false): Promise<string> {
  const path = sandboxPath(ticketId);
  if (existsSync(path)) { linkDeps(workdir, ticketId, frontendDeps); return path; } // rework continues in the same tree
  const branch = branchName(ticketId);
  // Branch may survive a removed worktree (e.g. manual cleanup): attach, else create.
  const attach = await git(workdir, "worktree", "add", path, branch);
  if (attach.code !== 0) await must(workdir, "worktree", "add", path, "-b", branch);
  linkDeps(workdir, ticketId, frontendDeps);
  return path;
}

export async function forgeCommit(ticketId: string, title: string): Promise<boolean> {
  const path = sandboxPath(ticketId);
  // The exclude pathspec is required on BOTH commands. .gitignore says
  // "node_modules/" — a trailing slash matches directories, so a Windows junction
  // is ignored but a POSIX symlink (a file) is not, and `add -A` would commit the
  // link. Excluding it only from `status` would hide it from the empty-check while
  // still staging it, which is worse: the link lands in the tree and the
  // nothing-changed case reports changes.
  // Stage everything, then drop the deps from the index. An exclude pathspec on
  // `add` looked cleaner but git fails it with "paths are ignored ... use -f" once a
  // real app/node_modules copy exists, with or without a positive "." pathspec —
  // reproduced on Linux both ways. Unstaging cannot hit that.
  //
  // Why this is needed at all: .gitignore says "node_modules/", and a trailing
  // slash matches directories only. A Windows junction is a directory so git
  // ignores it; a POSIX symlink is a file, so without this it gets committed.
  const DEPS = ["node_modules", "app/node_modules"];
  await must(path, "add", "-A");
  await git(path, "rm", "-r", "--cached", "--quiet", "--ignore-unmatch", ...DEPS);
  // The empty-check has to skip the deps too, or an unstaged link reads as a change.
  const { out } = await git(path, "status", "--porcelain", "--", ".",
    ...DEPS.map((d) => `:(exclude)${d}`));
  if (!out.trim()) return false;
  await must(path, "-c", "user.email=forge@vibeops.local", "-c", "user.name=VibeOps Forge",
    "commit", "-m", `forge: ${title}`);
  return true;
}

export async function sandboxDiff(workdir: string, ticketId: string): Promise<string> {
  const { out } = await git(workdir, "diff", `HEAD...${branchName(ticketId)}`);
  return out.slice(0, DIFF_CAP);
}

export async function sandboxDiffSummary(workdir: string, ticketId: string): Promise<string> {
  const { out } = await git(workdir, "diff", "--stat", `HEAD...${branchName(ticketId)}`);
  return out.slice(0, DIFF_CAP);
}

export async function sandboxDiffNames(workdir: string, ticketId: string): Promise<string[]> {
  const { out } = await git(workdir, "diff", "--name-only", `HEAD...${branchName(ticketId)}`);
  return out.split("\n").map((l) => l.replace(/\r$/, "").trim()).filter(Boolean);
}

export type SandboxActivityFile = { path: string; status: "A" | "M" | "D"; additions: number; deletions: number };
export type SandboxActivity = {
  files: SandboxActivityFile[];
  totalAdditions: number;
  totalDeletions: number;
  lastChangeAt: string;
};

const ACTIVITY_CACHE_MS = 2_000;
// ponytail: cache never evicted, keyed by resolved sandbox path (not raw
// ticketId) so it can't leak stale data across sandboxes. Grows for the
// process lifetime -- ticket volume is small enough this never matters.
// Upgrade path: evict on discardSandbox/promoteSandbox cleanup() if it ever does.
const activityCache = new Map<string, { at: number; data: SandboxActivity }>();

async function baseCommit(workdir: string, ticketId: string): Promise<string> {
  return (await must(workdir, "merge-base", "HEAD", branchName(ticketId))).trim();
}

function stripCR(s: string): string {
  return s.replace(/\r$/, "");
}

// Read-only: status --porcelain (untracked files) + diff --numstat/--name-status
// against the base commit, run from inside the worktree so uncommitted edits
// are included alongside anything already committed to the forge branch.
export async function sandboxActivity(workdir: string, ticketId: string): Promise<SandboxActivity> {
  const path = sandboxPath(ticketId);
  const cached = activityCache.get(path);
  if (cached && Date.now() - cached.at < ACTIVITY_CACHE_MS) return cached.data;

  const base = await baseCommit(workdir, ticketId);
  const [numstat, nameStatus, status] = await Promise.all([
    git(path, "diff", "--no-renames", "--numstat", base),
    git(path, "diff", "--no-renames", "--name-status", base),
    git(path, "status", "--porcelain"),
  ]);

  const counts = new Map<string, { additions: number; deletions: number }>();
  for (const raw of numstat.out.split("\n")) {
    const line = stripCR(raw);
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    counts.set(m[3], { additions: m[1] === "-" ? 0 : parseInt(m[1], 10), deletions: m[2] === "-" ? 0 : parseInt(m[2], 10) });
  }

  const files: SandboxActivityFile[] = [];
  for (const raw of nameStatus.out.split("\n")) {
    const line = stripCR(raw);
    const m = line.match(/^([AMD])\t(.+)$/);
    if (!m) continue;
    const filePath = m[2];
    const c = counts.get(filePath) ?? { additions: 0, deletions: 0 };
    files.push({ path: filePath, status: m[1] as "A" | "M" | "D", ...c });
  }

  // Untracked files: no baseline to diff against, so counts land at 0 until
  // forgeCommit's `git add -A` stages them -- read-only means no `git add -N` here.
  const seen = new Set(files.map((f) => f.path));
  for (const raw of status.out.split("\n")) {
    const line = stripCR(raw);
    if (!line.startsWith("?? ")) continue;
    const filePath = line.slice(3).trim();
    if (seen.has(filePath)) continue;
    files.push({ path: filePath, status: "A", additions: 0, deletions: 0 });
  }

  let lastChangeAt = 0;
  for (const f of files) {
    if (f.status === "D") continue;
    try { lastChangeAt = Math.max(lastChangeAt, statSync(join(path, f.path)).mtimeMs); } catch { /* deleted/renamed mid-poll */ }
  }

  const data: SandboxActivity = {
    files,
    totalAdditions: files.reduce((s, f) => s + f.additions, 0),
    totalDeletions: files.reduce((s, f) => s + f.deletions, 0),
    lastChangeAt: new Date(lastChangeAt || Date.now()).toISOString(),
  };
  activityCache.set(path, { at: Date.now(), data });
  return data;
}

// Same base-commit comparison as sandboxActivity, but returns the raw unified
// diff text for the diff viewer instead of a per-file summary.
export async function sandboxWorkingDiff(workdir: string, ticketId: string): Promise<string> {
  const base = await baseCommit(workdir, ticketId);
  const { out } = await git(sandboxPath(ticketId), "diff", "--no-renames", base);
  return out.slice(0, DIFF_CAP);
}

export async function sandboxHeadHash(workdir: string, ticketId: string): Promise<string> {
  const { out } = await git(workdir, "rev-parse", branchName(ticketId));
  return out.trim();
}

export async function hasCommitsToPromote(workdir: string, ticketId: string): Promise<boolean> {
  const { out } = await git(workdir, "rev-list", "--count", `HEAD..${branchName(ticketId)}`);
  return parseInt(out.trim(), 10) > 0;
}

const PROMOTE_SUBJECT_MAX = 72;

function promoteMessages(ticketId: string, title: string): { subject: string; body: string } {
  const safe = redactSecrets(title).replace(/\s+/g, " ").trim();
  let subject = `forge: promote ${safe}`;
  let truncated = false;
  if (subject.length > PROMOTE_SUBJECT_MAX) {
    subject = subject.slice(0, PROMOTE_SUBJECT_MAX - 3).trimEnd() + "...";
    truncated = true;
  }
  const body = truncated ? `${ticketId}\n\n${safe}` : ticketId;
  return { subject, body };
}

export async function promoteSandbox(workdir: string, ticketId: string, title: string, discardAfter = true): Promise<void> {
  const dirty = await git(workdir, "status", "--porcelain");
  if (dirty.out.trim()) {
    throw new ConflictError("workdir has uncommitted changes; commit or stash before promoting");
  }
  const { subject, body } = promoteMessages(ticketId, title);
  const merge = await git(workdir, "merge", "--no-ff", branchName(ticketId),
    "-m", subject, "-m", body);
  if (merge.code !== 0) {
    const conflicts = await git(workdir, "diff", "--name-only", "--diff-filter=U");
    await git(workdir, "merge", "--abort");
    const files = conflicts.out.split("\n").map((l) => l.replace(/\r$/, "").trim()).filter(Boolean);
    const named = files.length ? files.join(", ") : merge.out.trim().slice(0, 200);
    throw new ConflictError(
      `promote blocked: ${branchName(ticketId)} conflicts with the base in ${files.length} file(s): ${named}. ` +
      `The sandbox and branch are left intact; rework the ticket and re-run, or resolve the conflict before promoting again.`,
    );
  }
  if (discardAfter) await cleanup(workdir, ticketId);
}

export async function discardSandbox(workdir: string, ticketId: string): Promise<void> {
  await cleanup(workdir, ticketId);
}

async function cleanup(workdir: string, ticketId: string): Promise<void> {
  // MUST run before worktree remove: if a linked node_modules survives as a junction
  // and `worktree remove --force` (or any recursive delete) traverses into it, it
  // destroys the BASE repo's real node_modules. Unlinking first makes that impossible.
  unlinkDeps(ticketId);
  const path = sandboxPath(ticketId);
  await git(workdir, "worktree", "remove", "--force", path);
  // `git worktree remove` swallows its own failure and, with forge.frontendDeps, must
  // delete a real (gitignored) app/node_modules copy — on Windows that delete often
  // fails, leaving the whole worktree (and blocking branch -D). unlinkDeps already
  // removed every deps junction; re-verify none survived, then a recursive delete here
  // is safe because there is no reparse point left to traverse into the base repo.
  if (existsSync(path)) {
    for (const rel of DEPS_DIRS) {
      if (isLink(join(path, rel))) throw new Error(`refusing recursive cleanup of ${ticketId}: ${rel} is still a junction`);
    }
    rmSync(path, { recursive: true, force: true });
  }
  await git(workdir, "branch", "-D", branchName(ticketId));
  await git(workdir, "worktree", "prune");
}

export type DepsBaseline = { dir: string; entries: Map<string, number> }[];

// Top-level name->mtime snapshot of the base repo's shared deps dirs, taken
// OUTSIDE any sandbox before the work stage. A run that writes THROUGH the shared
// junction mutates these real dirs; comparing top-level entries after the run
// catches new/replaced top-level entries and lets us revert additions.
// ponytail: top-level only -- an in-place edit of an existing NESTED file bumps
// no top-level mtime and is not caught. Upgrade path: full recursive walk if a
// real postinstall is ever seen deep-writing the base.
export function snapshotDeps(workdir: string): DepsBaseline {
  const out: DepsBaseline = [];
  for (const rel of DEPS_DIRS) {
    const dir = resolve(join(workdir, rel));
    try {
      const entries = new Map<string, number>();
      for (const name of readdirSync(dir)) {
        try { entries.set(name, statSync(join(dir, name)).mtimeMs); } catch { /* vanished mid-scan */ }
      }
      out.push({ dir, entries });
    } catch { /* base has no such deps dir -- nothing to protect */ }
  }
  return out;
}

// Compare live base deps dirs against the baseline. ADDED top-level entries are
// deleted from the base (revert the leak) and reported; TOUCHED entries are
// reported but not restored (no byte snapshot). Empty array => clean.
export function detectDepsLeak(baseline: DepsBaseline): string[] {
  const leaked: string[] = [];
  for (const { dir, entries } of baseline) {
    let now: string[];
    try { now = readdirSync(dir); } catch { continue; }
    const nowSet = new Set(now);
    for (const name of now) {
      if (entries.has(name)) continue;
      const p = join(dir, name);
      try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort revert */ }
      leaked.push(`${p} (added; reverted)`);
    }
    for (const [name, mtime] of entries) {
      if (!nowSet.has(name)) continue;
      let cur: number;
      try { cur = statSync(join(dir, name)).mtimeMs; } catch { continue; }
      if (cur > mtime) leaked.push(`${join(dir, name)} (modified)`);
    }
  }
  return leaked;
}

// --- Range helpers for the mechanical gate ---

export async function sandboxBaseCommit(workdir: string, ticketId: string): Promise<string> {
  return (await must(workdir, "merge-base", "HEAD", branchName(ticketId))).trim();
}

// Full per-commit patch for base..branch (every commit, additions included) — a
// secret added in one commit and redacted in a later one still appears here.
// ponytail: DIFF_CAP may truncate a large range; if truncation ever hides a
// late-commit secret, raise the cap or stream per-commit.
export async function sandboxRangePatch(workdir: string, ticketId: string): Promise<string> {
  const { out } = await git(workdir, "log", "-p", "--no-color", "--no-renames",
    `${await sandboxBaseCommit(workdir, ticketId)}..${branchName(ticketId)}`);
  return out;
}

export async function sandboxDiffNameStatus(workdir: string, ticketId: string): Promise<{ status: "A" | "M" | "D"; path: string }[]> {
  const { out } = await git(workdir, "diff", "--no-renames", "--name-status", `HEAD...${branchName(ticketId)}`);
  return out.split("\n").map(stripCR).map(l => l.match(/^([AMD])\t(.+)$/)).filter(Boolean)
    .map(m => ({ status: m![1] as "A" | "M" | "D", path: m![2] }));
}

// Inside-sandbox checkout for the mutation probe. ref="<base>" reverts; ref="HEAD" restores.
export async function sandboxCheckout(ticketId: string, ref: string, paths: string[]): Promise<void> {
  if (paths.length) await git(sandboxPath(ticketId), "checkout", ref, "--", ...paths);
}

export async function sandboxDeletePaths(ticketId: string, paths: string[]): Promise<void> {
  for (const p of paths) rmSync(join(sandboxPath(ticketId), p), { force: true });
}
