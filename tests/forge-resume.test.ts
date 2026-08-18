import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { markInterruptedRuns, awaitRun, getRunOutput, stopRun, startPipeline, hasActiveRun, listRuns, listInterruptedRuns } from "../src/forge/runs.js";
import { ensureSandbox, forgeCommit } from "../src/forge/sandbox.js";
import { addComment } from "../src/services/comments.js";
import { loadRelayConfig } from "../src/relay/config.js";
import { clearSetting } from "./helpers/settings.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { createTicket, updateTicket } from "../src/services/tickets.js";
import { getTicket } from "../src/services/history.js";
import { app } from "../src/api/app.js";
import { db, closeDb } from "../src/db/client.js";
import { forgeRuns } from "../src/db/schema.js";

process.env.EMBED_PROVIDER = "fake";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(__dirname, "fixtures", "fake-agent.mjs");

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-resume-base-"));
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

async function seedTicket(title: string) {
  const { actor, apiKey } = await createActor({ name: uniq("resume-actor"), kind: "human", role: "admin" });
  const project = await createProject({ key: uniq("resume-proj"), name: "Forge Resume" });
  const ticket = await createTicket(actor.id, { projectId: project.id, title });
  return { actorId: actor.id, apiKey, ticket };
}

let workdir: string;
let sandboxRoot: string;
let counterDir: string;
let counterFile: string;

beforeEach(async () => {
  // This file starts auto-agent pipelines, so a forge.defaultModel.* row left in
  // the shared settings table by another test changes which agent resolves here.
  for (const role of ["plan", "work", "review"]) await clearSetting(`forge.defaultModel.${role}`);
  workdir = initRepo();
  sandboxRoot = mkdtempSync(join(tmpdir(), "forge-resume-sbx-"));
  process.env.VIBEOPS_SANDBOX_ROOT = sandboxRoot;
  counterDir = mkdtempSync(join(tmpdir(), "forge-resume-ctr-"));
  counterFile = join(counterDir, "counter.txt");
  
  process.env.VIBEOPS_RELAY_CONFIG = join(workdir, "relay.json");
  writeFileSync(process.env.VIBEOPS_RELAY_CONFIG, JSON.stringify({
    workdir,
    agents: {
      fake: {
        cmd: [process.execPath, FAKE_AGENT, "{prompt}", "--model", "{model}"],
        roles: ["plan", "work", "review"],
        models: [{ name: "fast", tier: "free", quality: 2 }],
      },
    },
  }));
});

afterEach(() => {
  delete process.env.VIBEOPS_SANDBOX_ROOT;
  delete process.env.VIBEOPS_RELAY_CONFIG;
  delete process.env.FAKE_SCRIPT;
  delete process.env.FAKE_COUNTER_FILE;
  delete process.env.FAKE_WRITE;
  rmSync(workdir, { recursive: true, force: true });
  rmSync(sandboxRoot, { recursive: true, force: true });
  rmSync(counterDir, { recursive: true, force: true });
});

function setScript(script: string, write?: boolean): void {
  process.env.FAKE_SCRIPT = script;
  process.env.FAKE_COUNTER_FILE = counterFile;
  if (write) process.env.FAKE_WRITE = "1";
  else delete process.env.FAKE_WRITE;
}

async function waitForStage(runId: string, stage: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (getRunOutput(runId, 0)?.stage === stage) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for stage "${stage}"`);
}

// waitForStage flips when the work agent is spawned, which on a loaded runner is
// BEFORE the fixture writes its partial file. Poll the file so the stop always
// lands on a dirty tree (the WIP commit git reset HEAD~1 later depends on).
async function waitForFile(path: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for file "${path}"`);
}

// Persistence is fire-and-forget (settle() doesn't await the insert), so the
// row can land a tick or two after awaitRun resolves. Poll instead of racing.
// Same race, one step earlier: the INSERT itself is fire-and-forget, so a fixed
// sleep before markInterruptedRuns is a coin flip on a loaded runner — it read an
// empty table on Linux CI and returned somebody else's row.
async function waitForPersistedRow(runId: string, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    const [row] = await db.select().from(forgeRuns).where(eq(forgeRuns.id, runId));
    if (row) return row;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for run row ${runId}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function waitForPersistedStatus(runId: string, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    const [row] = await db.select().from(forgeRuns).where(eq(forgeRuns.id, runId));
    if (row && row.status !== "running") return row;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for persisted run ${runId}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("forge run resume", () => {
  it("markInterruptedRuns leaves a run this process still tracks untouched", async () => {
    const { actorId, apiKey, ticket } = await seedTicket("Interrupted path via pipeline");
    setScript("plan-hang", true);

    const config = loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG!);
    const { runId } = await startPipeline(actorId, config, {
      ticketId: ticket.id, planAgent: "auto", workAgent: "auto", reviewAgent: "auto"
    });

    await waitForPersistedRow(runId);

    // S2-A3: a live run still in THIS process's in-memory map is not a restart
    // casualty (real boot starts with an empty map). It is neither interrupted
    // nor reattached; the interrupt/reattach paths are exercised in
    // tests/forge-reattach.test.ts with raw orphan rows.
    const marked = await markInterruptedRuns();
    expect(marked).not.toContain(ticket.id);
    const [row] = await db.select().from(forgeRuns).where(eq(forgeRuns.id, runId));
    expect(row.status).toBe("running");
    expect(row.finishedAt).toBeNull();

    await stopRun(runId);
    await awaitRun(runId);
  });

  it("markInterruptedRuns sets finishedAt so hasActiveRun clears", async () => {
    const { ticket } = await seedTicket("Orphaned run row");
    await db.insert(forgeRuns).values({
      id: randomUUID(), ticketId: ticket.id, status: "running", stage: "plan",
      planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
      startedAt: new Date(), finishedAt: null,
    });
    const marked = await markInterruptedRuns();
    expect(marked).toContain(ticket.id);
    const [row] = await db.select().from(forgeRuns).where(eq(forgeRuns.ticketId, ticket.id));
    expect(row.status).toBe("interrupted");
    expect(row.finishedAt).not.toBeNull();
    expect(await hasActiveRun(ticket.id)).toBe(false);
  });

  it("resume route: seeded planned ticket -> 201 runId and pipeline completes; 409 on closed ticket", async () => {
    const { actorId, apiKey, ticket } = await seedTicket("Resume route path");
    await addComment(actorId, ticket.id, "The plan: create forge-made.txt", "plan");
    await updateTicket(actorId, ticket.id, ticket.version, { status: "planned" });
    setScript("work,review-pass", true);

    const h = { Authorization: `Bearer ${apiKey}` };
    const res = await app.request(`/forge/tickets/${ticket.id}/resume`, { method: "POST", headers: h });
    expect(res.status).toBe(201);
    const { runId } = await res.json();
    expect(runId).toBeTruthy();

    await awaitRun(runId);
    const output = getRunOutput(runId, 0);
    expect(output?.status).toBe("passed");
    expect(output?.chunk).not.toContain("=== FORGE plan");
    expect(output?.chunk).toContain("=== FORGE work");

    const t2 = await getTicket(ticket.id);
    await updateTicket(actorId, ticket.id, t2.version, { status: "closed" });

    const resClosed = await app.request(`/forge/tickets/${ticket.id}/resume`, { method: "POST", headers: h });
    expect(resClosed.status).toBe(409);
  });

  it("boot recovery marks but starts no pipeline", async () => {
    // Seed an orphan forge_runs row as if a process died mid-run
    const { ticket } = await seedTicket("Orphaned boot check");
    await db.insert(forgeRuns).values({
      id: randomUUID(), ticketId: ticket.id, status: "running", stage: "plan",
      planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
      startedAt: new Date(), finishedAt: null,
    });

    const marked = await markInterruptedRuns();
    expect(marked).toContain(ticket.id);

    // No run started for this ticket in memory
    const runs = listRuns();
    expect(runs.find(r => r.ticketId === ticket.id)).toBeUndefined();
    expect(await hasActiveRun(ticket.id)).toBe(false);
  });

  it("listInterruptedRuns annotates stage and sandbox honestly", async () => {
    const config = loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG!);

    // Case 1: stage=plan, no sandbox
    const { actorId: a1, ticket: t1 } = await seedTicket("Plan stage case");
    await db.insert(forgeRuns).values({
      id: randomUUID(), ticketId: t1.id, status: "interrupted", stage: "plan",
      planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
      startedAt: new Date(), finishedAt: new Date(),
    });

    // Case 2: stage=work, with sandbox but no commit
    const { actorId: a2, ticket: t2 } = await seedTicket("Work stage case");
    await ensureSandbox(workdir, t2.id);
    writeFileSync(join(sandboxRoot, t2.id, "dirty.txt"), "dirty");
    await db.insert(forgeRuns).values({
      id: randomUUID(), ticketId: t2.id, status: "interrupted", stage: "work",
      planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
      startedAt: new Date(), finishedAt: new Date(),
    });

    // Case 3: stage=review, sandbox with commits
    const { actorId: a3, ticket: t3 } = await seedTicket("Review stage case");
    await ensureSandbox(workdir, t3.id);
    writeFileSync(join(sandboxRoot, t3.id, "file.txt"), "content");
    await forgeCommit(t3.id, "test commit");
    await addComment(a3, t3.id, "report output", "report");
    await updateTicket(a3, t3.id, t3.version, { status: "review" });
    await db.insert(forgeRuns).values({
      id: randomUUID(), ticketId: t3.id, status: "interrupted", stage: "review",
      planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
      startedAt: new Date(), finishedAt: new Date(),
    });

    const items = await listInterruptedRuns(config);

    const item1 = items.find(i => i.ticketId === t1.id);
    expect(item1).toBeDefined();
    expect(item1!.resumeMode).toBe("plan");
    expect(item1!.resumable).toBe(true);
    expect(item1!.sandboxExists).toBe(false);
    expect(item1!.reason).toBeTruthy();

    const item2 = items.find(i => i.ticketId === t2.id);
    expect(item2).toBeDefined();
    expect(item2!.resumeMode).toBe("work");
    expect(item2!.resumable).toBe(true);
    expect(item2!.sandboxExists).toBe(true);
    expect(item2!.hasCommits).toBe(false);

    const item3 = items.find(i => i.ticketId === t3.id);
    expect(item3).toBeDefined();
    expect(item3!.resumeMode).toBe("review");
    expect(item3!.resumable).toBe(true);
    expect(item3!.hasCommits).toBe(true);
  });

  it("superseded interrupted run is excluded", async () => {
    const config = loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG!);
    const { actorId, ticket } = await seedTicket("Superseded run");

    // Insert an interrupted run
    await db.insert(forgeRuns).values({
      id: randomUUID(), ticketId: ticket.id, status: "interrupted", stage: "plan",
      planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
      startedAt: new Date(Date.now() - 10000), finishedAt: new Date(Date.now() - 9000),
    });

    // Insert a newer passed run
    await db.insert(forgeRuns).values({
      id: randomUUID(), ticketId: ticket.id, status: "passed", stage: "review",
      planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
      startedAt: new Date(), finishedAt: new Date(),
    });

    const items = await listInterruptedRuns(config);
    expect(items.find(i => i.ticketId === ticket.id)).toBeUndefined();
  });

  it("resume finds the targeted ticket's run past the 60-row unfiltered window", async () => {
    const config = loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG!);
    const { ticket: target } = await seedTicket("Past-window target");
    const base = Date.now() - 300_000;

    // Target's interrupted run: oldest of the batch.
    await db.insert(forgeRuns).values({
      id: randomUUID(), ticketId: target.id, status: "interrupted", stage: "plan",
      planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
      startedAt: new Date(base), finishedAt: new Date(base),
    });

    // 65 newer interrupted runs for unrelated tickets push the target past limit(60).
    for (let i = 1; i <= 65; i++) {
      await db.insert(forgeRuns).values({
        id: randomUUID(), ticketId: randomUUID(), status: "interrupted", stage: "plan",
        planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
        startedAt: new Date(base + i * 1000), finishedAt: new Date(base + i * 1000),
      });
    }

    // Unfiltered listing stays bounded at 60: the target row falls outside the window.
    const unfiltered = await listInterruptedRuns(config);
    expect(unfiltered.find(i => i.ticketId === target.id)).toBeUndefined();

    // Ticket-filtered query targets the row in SQL, so the limit cannot hide it.
    const filtered = await listInterruptedRuns(config, target.id);
    const item = filtered.find(i => i.ticketId === target.id);
    expect(item).toBeDefined();
    expect(item!.resumable).toBe(true);
    expect(item!.resumeMode).toBe("plan");
  });

  it("resume after work-commit goes straight to review and passes", async () => {
    const { actorId, apiKey, ticket } = await seedTicket("Resume to review");

    // Create sandbox with committed work
    await ensureSandbox(workdir, ticket.id);
    writeFileSync(join(sandboxRoot, ticket.id, "result.txt"), "work done");
    await forgeCommit(ticket.id, "test work");

    // Add plan and report comments as if work stage completed
    await addComment(actorId, ticket.id, "The plan is to do work on result.txt", "plan");
    await addComment(actorId, ticket.id, "Work completed successfully", "report");

    // Update ticket to review status
    const t2 = await getTicket(ticket.id);
    await updateTicket(actorId, ticket.id, t2.version, { status: "review" });

    // Insert an interrupted run in review stage
    await db.insert(forgeRuns).values({
      id: randomUUID(), ticketId: ticket.id, status: "interrupted", stage: "review",
      planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
      startedAt: new Date(), finishedAt: new Date(),
    });

    // Use review-pass script
    setScript("review-pass", false);

    const h = { Authorization: `Bearer ${apiKey}` };
    const res = await app.request(`/forge/tickets/${ticket.id}/resume`, { method: "POST", headers: h });
    expect(res.status).toBe(201);
    const { runId } = await res.json();

    await awaitRun(runId);
    const output = getRunOutput(runId, 0);
    expect(output?.status).toBe("passed");
    // Should contain resume marker, NOT work stage
    expect(output?.chunk).toContain("=== FORGE resume: straight to review");
    expect(output?.chunk).not.toContain("=== FORGE work");
  });

  it("resume with sandbox gone returns 409", async () => {
    const { actorId, apiKey, ticket } = await seedTicket("No sandbox resume");

    // Set ticket to review status (as if work completed)
    const t2 = await getTicket(ticket.id);
    await updateTicket(actorId, ticket.id, t2.version, { status: "review" });

    // Insert an interrupted run in review stage - but no sandbox/commits exist
    await db.insert(forgeRuns).values({
      id: randomUUID(), ticketId: ticket.id, status: "interrupted", stage: "review",
      planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
      startedAt: new Date(), finishedAt: new Date(),
    });

    const h = { Authorization: `Bearer ${apiKey}` };
    const res = await app.request(`/forge/tickets/${ticket.id}/resume`, { method: "POST", headers: h });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("sandbox");

    // Verify no run was created
    const runs = listRuns();
    expect(runs.find(r => r.ticketId === ticket.id)).toBeUndefined();
  });

  it("AC1: failed run with sandbox is resumable and resumes straight to review", async () => {
    const { actorId, apiKey, ticket } = await seedTicket("Failed run resume");
    const config = loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG!);

    // Create sandbox with committed work
    await ensureSandbox(workdir, ticket.id);
    writeFileSync(join(sandboxRoot, ticket.id, "result.txt"), "work done");
    await forgeCommit(ticket.id, "test work");

    // Add plan and report comments as if work stage completed
    await addComment(actorId, ticket.id, "The plan is to do work on result.txt", "plan");
    await addComment(actorId, ticket.id, "Work completed successfully", "report");

    // Update ticket to review status
    const t2 = await getTicket(ticket.id);
    await updateTicket(actorId, ticket.id, t2.version, { status: "review" });

    // Insert a FAILED run in review stage (not interrupted)
    await db.insert(forgeRuns).values({
      id: randomUUID(), ticketId: ticket.id, status: "failed", stage: "review",
      planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
      startedAt: new Date(), finishedAt: new Date(),
    });

    // listInterruptedRuns should include the failed run
    const items = await listInterruptedRuns(config);
    const item = items.find(i => i.ticketId === ticket.id);
    expect(item).toBeDefined();
    expect(item!.resumable).toBe(true);
    expect(item!.resumeMode).toBe("review");

    // Resume via HTTP should work
    setScript("review-pass", false);
    const h = { Authorization: `Bearer ${apiKey}` };
    const res = await app.request(`/forge/tickets/${ticket.id}/resume`, { method: "POST", headers: h });
    expect(res.status).toBe(201);
    const { runId } = await res.json();

    await awaitRun(runId);
    const output = getRunOutput(runId, 0);
    expect(output?.status).toBe("passed");
    expect(output?.chunk).toContain("=== FORGE resume: straight to review");
    expect(output?.chunk).not.toContain("=== FORGE work");
  });

  it("AC1: failed run at work stage resumes to work (not review)", async () => {
    const { actorId, apiKey, ticket } = await seedTicket("Failed work stage");
    const config = loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG!);

    // Create sandbox but no commits (work died before committing)
    await ensureSandbox(workdir, ticket.id);
    writeFileSync(join(sandboxRoot, ticket.id, "dirty.txt"), "partial");

    // Add plan comment
    await addComment(actorId, ticket.id, "The plan", "plan");

    // Update ticket to planned (work stage starts from planned)
    const t2 = await getTicket(ticket.id);
    await updateTicket(actorId, ticket.id, t2.version, { status: "planned" });

    // Insert a FAILED run in work stage
    await db.insert(forgeRuns).values({
      id: randomUUID(), ticketId: ticket.id, status: "failed", stage: "work",
      planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
      startedAt: new Date(), finishedAt: new Date(),
    });

    // listInterruptedRuns should include it with resumeMode=work
    const items = await listInterruptedRuns(config);
    const item = items.find(i => i.ticketId === ticket.id);
    expect(item).toBeDefined();
    expect(item!.resumable).toBe(true);
    expect(item!.resumeMode).toBe("work");
    expect(item!.sandboxExists).toBe(true);
  });

  it("failed run at work stage WITH a commit resumes to review, not work", async () => {
    const { actorId, ticket } = await seedTicket("Failed work stage committed");
    const config = loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG!);

    // Sandbox with a committed work diff (a sentinel/timeout WIP-committed it)
    await ensureSandbox(workdir, ticket.id);
    writeFileSync(join(sandboxRoot, ticket.id, "result.txt"), "work done");
    await forgeCommit(ticket.id, "WIP (deps leak) committed work");

    await addComment(actorId, ticket.id, "The plan", "plan");
    const t2 = await getTicket(ticket.id);
    await updateTicket(actorId, ticket.id, t2.version, { status: "planned" });

    await db.insert(forgeRuns).values({
      id: randomUUID(), ticketId: ticket.id, status: "failed", stage: "work",
      planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
      startedAt: new Date(), finishedAt: new Date(),
    });

    const items = await listInterruptedRuns(config);
    const item = items.find(i => i.ticketId === ticket.id);
    expect(item).toBeDefined();
    expect(item!.resumable).toBe(true);
    expect(item!.hasCommits).toBe(true);
    expect(item!.resumeMode).toBe("review");
    expect(item!.reason).toContain("Retry"); // tradeoff surfaced to operator
  });

  it("AC2: failed run with no sandbox is refused with reason", async () => {
    const { actorId, apiKey, ticket } = await seedTicket("Failed no sandbox");

    // Set ticket to review status
    const t2 = await getTicket(ticket.id);
    await updateTicket(actorId, ticket.id, t2.version, { status: "review" });

    // Insert a FAILED run in review stage — but no sandbox/commits exist
    await db.insert(forgeRuns).values({
      id: randomUUID(), ticketId: ticket.id, status: "failed", stage: "review",
      planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
      startedAt: new Date(), finishedAt: new Date(),
    });

    const h = { Authorization: `Bearer ${apiKey}` };
    const res = await app.request(`/forge/tickets/${ticket.id}/resume`, { method: "POST", headers: h });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("sandbox");

    // Verify no run was created
    const runs = listRuns();
    expect(runs.find(r => r.ticketId === ticket.id)).toBeUndefined();
  });

  it("killed mid-work reports the stage it died in and that its sandbox survives", async () => {
    const { actorId, ticket } = await seedTicket("Kill mid-work");
    const config = loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG!);

    // Use plan -> work-hang sequence: plan completes, work hangs with partial file
    setScript("plan,work-hang", false);

    const { runId } = await startPipeline(actorId, config, {
      ticketId: ticket.id, planAgent: "auto", workAgent: "auto", reviewAgent: "auto"
    });

    // Wait for work stage to start and write partial files.
    // Fixed sleeps flake under CPU contention; poll stage instead.
    await waitForStage(runId, "work");
    await waitForFile(join(sandboxRoot, ticket.id, "partial.txt"));

    // Simulate process kill: stop the run, wait for it to settle, then UPDATE
    // the DB row to "interrupted" as if it hadn't settled cleanly (simulating
    // what markInterruptedRuns does on boot for runs with null finishedAt).
    await stopRun(runId);
    await awaitRun(runId);
    // settle() persists the terminal status fire-and-forget (runs.ts:543). Wait for
    // that write to land before overwriting to "interrupted", else the late insert
    // clobbers the update back to the settled status and listInterruptedRuns drops it.
    await waitForPersistedStatus(runId);

    // stopRun WIP-committed the partial file; uncommit it so the sandbox is dirty
    // without branch commits, simulating a hard crash mid-work.
    execFileSync("git", ["reset", "HEAD~1"], { cwd: join(sandboxRoot, ticket.id) });

    // Overwrite the run to look like a crash (status=interrupted) rather than clean stop
    await db.update(forgeRuns)
      .set({ status: "interrupted" })
      .where(eq(forgeRuns.id, runId));

    // Now check that listInterruptedRuns reports honestly
    const items = await listInterruptedRuns(config);
    const item = items.find(i => i.ticketId === ticket.id);

    expect(item).toBeDefined();
    expect(item!.stage).toBe("work");
    expect(item!.sandboxExists).toBe(true);
    expect(item!.resumable).toBe(true);
    expect(item!.resumeMode).toBe("work");
    expect(item!.reason).toContain("uncommitted");
  });

  it("in_progress ticket whose latest run is interrupted resumes and completes", async () => {
    const { actorId, apiKey, ticket } = await seedTicket("Interrupted in_progress resume");

    // Sandbox with a committed work diff — the exact rework-mid-flight shape:
    // listInterruptedRuns would map this to resumeMode "review", which startPipeline
    // rejects for an in_progress ticket. The fix forces resumeStage "work" instead.
    await ensureSandbox(workdir, ticket.id);
    writeFileSync(join(sandboxRoot, ticket.id, "result.txt"), "prior work");
    await forgeCommit(ticket.id, "prior work commit");

    await addComment(actorId, ticket.id, "The plan: create forge-made.txt and result.txt", "plan");
    await addComment(actorId, ticket.id, "Work in progress", "report");

    // Drive the ticket to in_progress (open -> planned -> in_progress).
    const t1 = await getTicket(ticket.id);
    const t2 = await updateTicket(actorId, ticket.id, t1.version, { status: "planned" });
    await updateTicket(actorId, ticket.id, t2.version, { status: "in_progress" });

    // Seed the interrupted work-stage run as the latest run for this ticket.
    await db.insert(forgeRuns).values({
      id: randomUUID(), ticketId: ticket.id, status: "interrupted", stage: "work",
      planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
      startedAt: new Date(), finishedAt: new Date(),
    });

    setScript("work,review-pass", true);
    const h = { Authorization: `Bearer ${apiKey}` };
    const res = await app.request(`/forge/tickets/${ticket.id}/resume`, { method: "POST", headers: h });
    expect(res.status).toBe(201);
    const { runId } = await res.json();
    expect(runId).toBeTruthy();

    await awaitRun(runId);
    const output = getRunOutput(runId, 0);
    expect(output?.status).toBe("passed");
    // Planned-like: plan reused (not regenerated), work re-runs.
    expect(output?.chunk).not.toContain("=== FORGE plan");
    expect(output?.chunk).toContain("=== FORGE work");
  });

  it("in_progress ticket with a genuinely active run still 409s", async () => {
    const { actorId, apiKey, ticket } = await seedTicket("Active run must not resume");

    const t1 = await getTicket(ticket.id);
    const t2 = await updateTicket(actorId, ticket.id, t1.version, { status: "planned" });
    await updateTicket(actorId, ticket.id, t2.version, { status: "in_progress" });

    await db.insert(forgeRuns).values({
      id: randomUUID(), ticketId: ticket.id, status: "running", stage: "work",
      planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
      startedAt: new Date(), finishedAt: null,
    });

    const h = { Authorization: `Bearer ${apiKey}` };
    const res = await app.request(`/forge/tickets/${ticket.id}/resume`, { method: "POST", headers: h });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("open or planned");

    const runs = listRuns();
    expect(runs.find((r) => r.ticketId === ticket.id)).toBeUndefined();
  });

  it("planned ticket with a work commit resumes to review via /resume (recovery mode agrees)", async () => {
    const { actorId, apiKey, ticket } = await seedTicket("Planned resume to review");
    const config = loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG!);

    // Work committed a diff, then the run died -> ticket bounced to planned.
    await ensureSandbox(workdir, ticket.id);
    writeFileSync(join(sandboxRoot, ticket.id, "result.txt"), "work done");
    await forgeCommit(ticket.id, "WIP committed work");
    await addComment(actorId, ticket.id, "The plan is to do work on result.txt", "plan");
    await addComment(actorId, ticket.id, "Work completed", "report");
    const t2 = await getTicket(ticket.id);
    await updateTicket(actorId, ticket.id, t2.version, { status: "planned" });
    await db.insert(forgeRuns).values({
      id: randomUUID(), ticketId: ticket.id, status: "failed", stage: "work",
      planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
      startedAt: new Date(), finishedAt: new Date(),
    });

    // Recovery advertises review for this planned+commit state.
    const item = (await listInterruptedRuns(config, ticket.id))[0];
    expect(item.resumeMode).toBe("review");
    expect(item.resumable).toBe(true);

    // /resume AGREES: 201, straight to review, no work re-run.
    setScript("review-pass", false);
    const h = { Authorization: `Bearer ${apiKey}` };
    const res = await app.request(`/forge/tickets/${ticket.id}/resume`, { method: "POST", headers: h });
    expect(res.status).toBe(201);
    const { runId } = await res.json();
    await awaitRun(runId);
    const output = getRunOutput(runId, 0);
    expect(output?.status).toBe("passed");
    expect(output?.chunk).toContain("=== FORGE resume: straight to review");
    expect(output?.chunk).not.toContain("=== FORGE work");
  });

  it("startPipeline refuses resumeStage review when no work commit exists", async () => {
    const { actorId, ticket } = await seedTicket("No commit review guard");
    const config = loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG!);
    const t2 = await getTicket(ticket.id);
    await updateTicket(actorId, ticket.id, t2.version, { status: "review" });
    await expect(
      startPipeline(actorId, config, {
        ticketId: ticket.id, planAgent: "auto", workAgent: "auto", reviewAgent: "auto", resumeStage: "review",
      }),
    ).rejects.toThrow(/no work commit/);
    expect(listRuns().find((r) => r.ticketId === ticket.id)).toBeUndefined();
  });

  // MUST be last test: closeDb ends the connection for subsequent tests
  it("closeDb is idempotent and does not throw", async () => {
    // Under vitest isEmbedded is false, so this exercises the sql.end branch
    await expect(closeDb()).resolves.not.toThrow();
    // Idempotent: calling again must not throw either
    await expect(closeDb()).resolves.not.toThrow();
  });
});
