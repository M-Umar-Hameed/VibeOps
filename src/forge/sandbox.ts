import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readlinkSync, rmdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ConflictError } from "../services/errors.js";

// Candidate deps dirs to link from the base repo into a sandbox, so work agents
// (fresh worktree, no install) can run tests without a full npm install per ticket.
const DEPS_DIRS = ["node_modules", join("app", "node_modules")];

const DIFF_CAP = 150_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertTicketId(id: string): void {
  if (!UUID.test(id)) throw new Error(`invalid ticket id "${id}"`);
}

function sandboxRoot(): string {
  return process.env.VIBEOPS_SANDBOX_ROOT ?? join(homedir(), ".vibeops", "sandbox");
}

export function sandboxPath(ticketId: string): string {
  assertTicketId(ticketId);
  return join(sandboxRoot(), ticketId);
}

export function branchName(ticketId: string): string {
  assertTicketId(ticketId);
  return `forge/${ticketId}`;
}

export function sandboxExists(ticketId: string): boolean {
  return existsSync(sandboxPath(ticketId));
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

// Link (never copy) base repo deps into the sandbox: junction on win32, symlink elsewhere.
// Never throws — a missing/failed link just means the work agent can't run tests, not a broken sandbox.
export function linkDeps(workdir: string, ticketId: string): void {
  const sbx = sandboxPath(ticketId);
  for (const rel of DEPS_DIRS) {
    const src = resolve(join(workdir, rel));
    const dest = join(sbx, rel);
    if (!existsSync(src) || existsSync(dest)) continue;
    try {
      mkdirSync(dirname(dest), { recursive: true });
      symlinkSync(src, dest, process.platform === "win32" ? "junction" : "dir");
    } catch (e) {
      console.warn(`linkDeps: failed to link ${rel}: ${String(e)}`);
    }
  }
}

// Remove only the links created by linkDeps, never a real directory.
// Detection: readlink succeeds on junctions/symlinks, throws (EINVAL/ENOENT) on real dirs or missing paths.
// rmdirSync on a junction/symlink-to-dir removes the link itself, not its target's contents.
export function unlinkDeps(ticketId: string): void {
  const sbx = sandboxPath(ticketId);
  for (const rel of DEPS_DIRS) {
    const dest = join(sbx, rel);
    try {
      readlinkSync(dest);
      rmdirSync(dest);
    } catch {
      // not a link (real dir, or doesn't exist) — leave it alone
    }
  }
}

export async function ensureSandbox(workdir: string, ticketId: string): Promise<string> {
  const path = sandboxPath(ticketId);
  if (existsSync(path)) { linkDeps(workdir, ticketId); return path; } // rework continues in the same tree
  const branch = branchName(ticketId);
  // Branch may survive a removed worktree (e.g. manual cleanup): attach, else create.
  const attach = await git(workdir, "worktree", "add", path, branch);
  if (attach.code !== 0) await must(workdir, "worktree", "add", path, "-b", branch);
  linkDeps(workdir, ticketId);
  return path;
}

export async function forgeCommit(ticketId: string, title: string): Promise<boolean> {
  const path = sandboxPath(ticketId);
  await must(path, "add", "-A");
  const { out } = await git(path, "status", "--porcelain");
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

export async function sandboxHeadHash(workdir: string, ticketId: string): Promise<string> {
  const { out } = await git(workdir, "rev-parse", branchName(ticketId));
  return out.trim();
}

export async function hasCommitsToPromote(workdir: string, ticketId: string): Promise<boolean> {
  const { out } = await git(workdir, "rev-list", "--count", `HEAD..${branchName(ticketId)}`);
  return parseInt(out.trim(), 10) > 0;
}

export async function promoteSandbox(workdir: string, ticketId: string): Promise<void> {
  const dirty = await git(workdir, "status", "--porcelain");
  if (dirty.out.trim()) {
    throw new ConflictError("workdir has uncommitted changes; commit or stash before promoting");
  }
  const merge = await git(workdir, "merge", "--no-ff", branchName(ticketId),
    "-m", `forge: promote ${ticketId}`);
  if (merge.code !== 0) {
    await git(workdir, "merge", "--abort");
    throw new ConflictError(`merge failed: ${merge.out.trim().slice(0, 500)}`);
  }
  await cleanup(workdir, ticketId);
}

export async function discardSandbox(workdir: string, ticketId: string): Promise<void> {
  await cleanup(workdir, ticketId);
}

async function cleanup(workdir: string, ticketId: string): Promise<void> {
  // MUST run before worktree remove: if a linked node_modules survives as a junction
  // and `worktree remove --force` (or any recursive delete) traverses into it, it
  // destroys the BASE repo's real node_modules. Unlinking first makes that impossible.
  unlinkDeps(ticketId);
  await git(workdir, "worktree", "remove", "--force", sandboxPath(ticketId));
  await git(workdir, "branch", "-D", branchName(ticketId));
  await git(workdir, "worktree", "prune");
}
