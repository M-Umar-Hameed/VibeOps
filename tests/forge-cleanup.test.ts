import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
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
});
