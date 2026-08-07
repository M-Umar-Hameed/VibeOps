import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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

describe("forge run resume", () => {
  it("startPipeline inserts running row, markInterruptedRuns flips it", async () => {
    const { actorId, apiKey, ticket } = await seedTicket("Interrupted path via pipeline");
    setScript("plan-hang", true);

    const config = loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG!);
    const { runId } = await startPipeline(actorId, config, {
      ticketId: ticket.id, planAgent: "auto", workAgent: "auto", reviewAgent: "auto"
    });
    
    // give persistRun a moment to complete
    await new Promise(r => setTimeout(r, 100));

    const marked = await markInterruptedRuns();
    expect(marked).toContain(ticket.id);
    const [row] = await db.select().from(forgeRuns).where(eq(forgeRuns.id, runId));
    expect(row.status).toBe("interrupted");
    expect(row.finishedAt).not.toBeNull();
    
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

  it("resume after work-commit goes straight to review and passes", async () => {
    const { actorId, apiKey, ticket } = await seedTicket("Resume to review");

    // Create sandbox with committed work
    await ensureSandbox(workdir, ticket.id);
    writeFileSync(join(sandboxRoot, ticket.id, "result.txt"), "work done");
    await forgeCommit(ticket.id, "test work");

    // Add plan and report comments as if work stage completed
    await addComment(actorId, ticket.id, "The plan is to do work", "plan");
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

  it("killed mid-work reports the stage it died in and that its sandbox survives", async () => {
    const { actorId, ticket } = await seedTicket("Kill mid-work");
    const config = loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG!);

    // Use plan -> work-hang sequence: plan completes, work hangs with partial file
    setScript("plan,work-hang", false);

    const { runId } = await startPipeline(actorId, config, {
      ticketId: ticket.id, planAgent: "auto", workAgent: "auto", reviewAgent: "auto"
    });

    // Wait for work stage to start and write partial files
    await new Promise(r => setTimeout(r, 1000));

    // Simulate process kill: stop the run, wait for it to settle, then UPDATE
    // the DB row to "interrupted" as if it hadn't settled cleanly (simulating
    // what markInterruptedRuns does on boot for runs with null finishedAt).
    await stopRun(runId);
    await awaitRun(runId);

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

  // MUST be last test: closeDb ends the connection for subsequent tests
  it("closeDb is idempotent and does not throw", async () => {
    // Under vitest isEmbedded is false, so this exercises the sql.end branch
    await expect(closeDb()).resolves.not.toThrow();
    // Idempotent: calling again must not throw either
    await expect(closeDb()).resolves.not.toThrow();
  });
});
