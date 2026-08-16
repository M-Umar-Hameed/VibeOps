import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cleanupMergedSandboxes } from "../src/forge/runs.js";
import { ensureSandbox, forgeCommit, promoteSandbox, sandboxExists, sandboxPath } from "../src/forge/sandbox.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { createTicket, updateTicket } from "../src/services/tickets.js";
import { getTicket } from "../src/services/history.js";
import { db } from "../src/db/client.js";
import { forgeRuns } from "../src/db/schema.js";

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-run-base-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  g("init", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "readme.md"), "base\n");
  g("add", "-A");
  g("commit", "-m", "base");
  return dir;
}

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

let workdir: string;
let sandboxRoot: string;

beforeEach(() => {
  workdir = initRepo();
  sandboxRoot = mkdtempSync(join(tmpdir(), "forge-run-sbx-"));
  process.env.VIBEOPS_SANDBOX_ROOT = sandboxRoot;
});

afterEach(() => {
  delete process.env.VIBEOPS_SANDBOX_ROOT;
  rmSync(workdir, { recursive: true, force: true });
  rmSync(sandboxRoot, { recursive: true, force: true });
});

function relayConfig(): any {
  return { workdir };
}

describe("forge cleanup", () => {
  it("discards a closed ticket whose branch is already merged, reports bytes, base node_modules intact", async () => {
    const { actor } = await createActor({ name: uniq("a"), kind: "human", role: "admin" });
    const project = await createProject({ key: uniq("p"), name: "Forge" });
    const ticket = await createTicket(actor.id, { projectId: project.id, title: "Merged work" });
    // base repo needs a node_modules to prove it survives
    mkdirSync(join(workdir, "node_modules"), { recursive: true });
    writeFileSync(join(workdir, "node_modules", "marker.txt"), "base\n");
    writeFileSync(join(workdir, ".gitignore"), "node_modules/\n");
    execFileSync("git", ["add", "-A"], { cwd: workdir });
    execFileSync("git", ["commit", "-m", "gi"], { cwd: workdir });

    const sp = await ensureSandbox(workdir, ticket.id);
    writeFileSync(join(sp, "big.txt"), "z".repeat(4000));
    await forgeCommit(ticket.id, "work");
    await promoteSandbox(workdir, ticket.id, ticket.title, false); // merged but KEPT on disk
    await updateTicket(actor.id, ticket.id, (await getTicket(ticket.id)).version, { status: "closed" });
    expect(sandboxExists(ticket.id)).toBe(true); // precondition: leftover exists

    const res = await cleanupMergedSandboxes(relayConfig());
    expect(res.discarded).toContain(ticket.id);
    expect(res.reclaimedBytes).toBeGreaterThanOrEqual(4000);
    expect(sandboxExists(ticket.id)).toBe(false);
    expect(existsSync(join(workdir, "node_modules", "marker.txt"))).toBe(true); // AC5
  });

  it("skips a sandbox whose branch has commits not in master", async () => {
    const { actor } = await createActor({ name: uniq("a"), kind: "human", role: "admin" });
    const project = await createProject({ key: uniq("p"), name: "Forge" });
    const ticket = await createTicket(actor.id, { projectId: project.id, title: "Unmerged" });
    const sp = await ensureSandbox(workdir, ticket.id);
    writeFileSync(join(sp, "b.txt"), "x\n");
    await forgeCommit(ticket.id, "work"); // committed but NOT promoted -> commits ahead
    await updateTicket(actor.id, ticket.id, (await getTicket(ticket.id)).version, { status: "closed" });

    const res = await cleanupMergedSandboxes(relayConfig());
    expect(res.discarded).not.toContain(ticket.id);
    expect(sandboxExists(ticket.id)).toBe(true);
  });

  it("skips a ticket with an active run even if merged and closed", async () => {
    const { actor } = await createActor({ name: uniq("a"), kind: "human", role: "admin" });
    const project = await createProject({ key: uniq("p"), name: "Forge" });
    const ticket = await createTicket(actor.id, { projectId: project.id, title: "Active" });
    await ensureSandbox(workdir, ticket.id);
    await promoteSandbox(workdir, ticket.id, ticket.title, false);
    await updateTicket(actor.id, ticket.id, (await getTicket(ticket.id)).version, { status: "closed" });
    // force an active run: forge_runs row with finishedAt NULL
    await db.insert(forgeRuns).values({
      id: randomUUID(), ticketId: ticket.id, status: "running", stage: "work",
      planAgent: "x", workAgent: "x", reviewAgent: "x", startedAt: new Date(), finishedAt: null,
    });

    const res = await cleanupMergedSandboxes(relayConfig());
    expect(res.discarded).not.toContain(ticket.id);
    expect(sandboxExists(ticket.id)).toBe(true);
  });

  it("skips a non-closed ticket", async () => {
    const { actor } = await createActor({ name: uniq("a"), kind: "human", role: "admin" });
    const project = await createProject({ key: uniq("p"), name: "Forge" });
    const ticket = await createTicket(actor.id, { projectId: project.id, title: "Open" });
    await ensureSandbox(workdir, ticket.id);
    await promoteSandbox(workdir, ticket.id, ticket.title, false); // merged but ticket left open
    const res = await cleanupMergedSandboxes(relayConfig());
    expect(res.discarded).not.toContain(ticket.id);
    expect(sandboxExists(ticket.id)).toBe(true);
  });

  it("deletes link-free closed orphans and reports them, without aborting the sweep; eligible sandbox still discarded, base node_modules intact", async () => {
    const { actor } = await createActor({ name: uniq("a"), kind: "human", role: "admin" });
    const project = await createProject({ key: uniq("p"), name: "Forge" });

    mkdirSync(join(workdir, "node_modules"), { recursive: true });
    writeFileSync(join(workdir, "node_modules", "marker.txt"), "base\n");
    writeFileSync(join(workdir, ".gitignore"), "node_modules/\n");
    execFileSync("git", ["add", "-A"], { cwd: workdir });
    execFileSync("git", ["commit", "-m", "gi"], { cwd: workdir });

    // eligible: closed ticket, branch merged, sandbox kept on disk (live worktree)
    const ticket = await createTicket(actor.id, { projectId: project.id, title: "Merged work" });
    const sp = await ensureSandbox(workdir, ticket.id);
    writeFileSync(join(sp, "big.txt"), "z".repeat(4000));
    await forgeCommit(ticket.id, "work");
    await promoteSandbox(workdir, ticket.id, ticket.title, false);
    await updateTicket(actor.id, ticket.id, (await getTicket(ticket.id)).version, { status: "closed" });

    // orphan 1: empty dir (interrupted run), closed ticket
    const emptyTicket = await createTicket(actor.id, { projectId: project.id, title: "Empty orphan" });
    await updateTicket(actor.id, emptyTicket.id, (await getTicket(emptyTicket.id)).version, { status: "closed" });
    const emptyOrphan = emptyTicket.id;
    mkdirSync(join(sandboxRoot, emptyOrphan));

    // orphan 2: partial tree, no .git, NESTED PLAIN DIRS, closed ticket
    const partialTicket = await createTicket(actor.id, { projectId: project.id, title: "Partial orphan" });
    await updateTicket(actor.id, partialTicket.id, (await getTicket(partialTicket.id)).version, { status: "closed" });
    const partialOrphan = partialTicket.id;
    mkdirSync(join(sandboxRoot, partialOrphan, "app", "src"), { recursive: true });
    writeFileSync(join(sandboxRoot, partialOrphan, "app", "src", "leftover.txt"), "x\n");

    const res = await cleanupMergedSandboxes(relayConfig());

    // regression: the orphan did not stop the eligible sandbox being reclaimed
    expect(res.discarded).toContain(ticket.id);
    expect(sandboxExists(ticket.id)).toBe(false);
    // link-free closed orphans deleted and reported
    expect(res.deletedOrphans).toContain(emptyOrphan);
    expect(res.deletedOrphans).toContain(partialOrphan);
    expect(existsSync(join(sandboxRoot, emptyOrphan))).toBe(false);
    expect(existsSync(join(sandboxRoot, partialOrphan))).toBe(false);
    // base node_modules intact (AC5)
    expect(existsSync(join(workdir, "node_modules", "marker.txt"))).toBe(true);
  });

  it("leaves and reports an orphan containing a junction/symlink; base node_modules intact", async () => {
    const { actor } = await createActor({ name: uniq("a"), kind: "human", role: "admin" });
    const project = await createProject({ key: uniq("p"), name: "Forge" });

    mkdirSync(join(workdir, "node_modules"), { recursive: true });
    writeFileSync(join(workdir, "node_modules", "marker.txt"), "base\n");

    const t = await createTicket(actor.id, { projectId: project.id, title: "Linked orphan" });
    await updateTicket(actor.id, t.id, (await getTicket(t.id)).version, { status: "closed" });
    const orphan = t.id;
    const dir = join(sandboxRoot, orphan);
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", "index.js"), "x\n");
    // link the base node_modules INTO the orphan -- exactly the junction-traversal hazard
    symlinkSync(join(workdir, "node_modules"), join(dir, "app", "node_modules"),
      process.platform === "win32" ? "junction" : "dir");

    const res = await cleanupMergedSandboxes(relayConfig());

    expect(res.orphans).toContain(orphan);
    expect(res.deletedOrphans).not.toContain(orphan);
    expect(existsSync(dir)).toBe(true);                                        // left on disk by the guard
    expect(existsSync(join(workdir, "node_modules", "marker.txt"))).toBe(true); // base intact
  });
});
