import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { startPipeline, awaitRun, getRunOutput, listRunsWithHistory, hasActiveRun, listRuns } from "../src/forge/runs.js";
import { ensureSandbox, forgeCommit } from "../src/forge/sandbox.js";
import { addComment, listComments } from "../src/services/comments.js";
import { clearSetting, withSetting } from "./helpers/settings.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { createTicket, updateTicket } from "../src/services/tickets.js";
import { getTicket } from "../src/services/history.js";
import { app } from "../src/api/app.js";
import { db } from "../src/db/client.js";
import { forgeRuns } from "../src/db/schema.js";
import { loadRelayConfig } from "../src/relay/config.js";

process.env.EMBED_PROVIDER = "fake";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(__dirname, "fixtures", "fake-agent.mjs");

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-rework-base-"));
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
  const { actor, apiKey } = await createActor({ name: uniq("rework-actor"), kind: "human", role: "admin" });
  const project = await createProject({ key: uniq("rework-proj"), name: "Forge Rework" });
  const ticket = await createTicket(actor.id, { projectId: project.id, title });
  return { actorId: actor.id, apiKey, ticket };
}

async function seedRejected(title: string) {
  const { actorId, apiKey, ticket } = await seedTicket(title);
  await ensureSandbox(workdir, ticket.id);
  writeFileSync(join(sandboxRoot, ticket.id, "result.txt"), "first pass");
  await forgeCommit(ticket.id, "first work");
  await addComment(actorId, ticket.id, "The plan\nFiles: result.txt", "plan");
  await addComment(actorId, ticket.id, "- Critical: bug\nVERDICT: FAIL", "review");
  const t2 = await getTicket(ticket.id);
  await updateTicket(actorId, ticket.id, t2.version, { status: "planned" });
  await db.insert(forgeRuns).values({
    id: randomUUID(), ticketId: ticket.id, status: "rejected", stage: "review",
    planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
    startedAt: new Date(), finishedAt: new Date(),
  });
  return { actorId, apiKey, ticket };
}

function enableSmartModel() {
  writeFileSync(process.env.VIBEOPS_RELAY_CONFIG!, JSON.stringify({
    workdir,
    agents: {
      fake: {
        cmd: [process.execPath, FAKE_AGENT, "{prompt}", "--model", "{model}"],
        roles: ["plan", "work", "review"],
        models: [
          { name: "fast", tier: "free", quality: 2 },
          { name: "smart", tier: "expensive", quality: 5 },
        ],
      },
    },
  }));
}

let workdir: string;
let sandboxRoot: string;
let counterDir: string;
let counterFile: string;

beforeEach(async () => {
  for (const role of ["plan", "work", "review"]) await clearSetting(`forge.defaultModel.${role}`);
  workdir = initRepo();
  sandboxRoot = mkdtempSync(join(tmpdir(), "forge-rework-sbx-"));
  process.env.VIBEOPS_SANDBOX_ROOT = sandboxRoot;
  counterDir = mkdtempSync(join(tmpdir(), "forge-rework-ctr-"));
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
  delete process.env.FAKE_WRITE_PATH;
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

describe("POST /forge/tickets/:id/rework", () => {
  it("rework on a rejected ticket: same sandbox, no plan stage, worker prompt carries findings verbatim", async () => {
    const { actorId, apiKey, ticket } = await seedTicket("Rework reuses sandbox");

    // Existing sandbox with a prior commit (the rejected run's work).
    await ensureSandbox(workdir, ticket.id);
    writeFileSync(join(sandboxRoot, ticket.id, "result.txt"), "first pass");
    await forgeCommit(ticket.id, "first work");
    const priorHash = execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(sandboxRoot, ticket.id) }).toString().trim();

    // Durable plan + a REJECTED review carrying a distinctive Critical finding.
    await addComment(actorId, ticket.id, "The plan: edit result.txt\nFiles: result.txt", "plan");
    await addComment(actorId, ticket.id, "REASON: the widget crashes on empty input.\n- Critical: WIDGET-BUG-XYZZY empty input crash\nVERDICT: FAIL", "review");
    const t2 = await getTicket(ticket.id);
    await updateTicket(actorId, ticket.id, t2.version, { status: "planned" });

    // Persist a rejected run so latestRunStatus() sees it.
    await db.insert(forgeRuns).values({
      id: randomUUID(), ticketId: ticket.id, status: "rejected", stage: "review",
      planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
      startedAt: new Date(), finishedAt: new Date(),
    });

    // Work agent echoes its prompt so we can assert the findings reached it; review passes.
    setScript("echo-prompt,review-pass", false);

    const h = { Authorization: `Bearer ${apiKey}` };
    const res = await app.request(`/forge/tickets/${ticket.id}/rework`, { method: "POST", headers: h });
    expect(res.status).toBe(201);
    const { runId } = await res.json();

    await awaitRun(runId);
    const output = getRunOutput(runId, 0);
    // No plan stage; work stage ran.
    expect(output?.chunk).not.toContain("=== FORGE plan");
    expect(output?.chunk).toContain("=== FORGE work");
    // Worker prompt carried the review findings verbatim.
    expect(output?.chunk).toContain("prior-review-findings");
    expect(output?.chunk).toContain("WIDGET-BUG-XYZZY empty input crash");
    // Prior commit still on the branch (sandbox reused, commits intact).
    const log = execFileSync("git", ["log", "--format=%H"], { cwd: join(sandboxRoot, ticket.id) }).toString();
    expect(log).toContain(priorHash);
  });

  it("rework on a ticket with no rejected run returns 409 with a human reason", async () => {
    const { apiKey, ticket } = await seedTicket("Rework without rejection");
    const h = { Authorization: `Bearer ${apiKey}` };
    const res = await app.request(`/forge/tickets/${ticket.id}/rework`, { method: "POST", headers: h });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("no rejected run");
  });

  it("MUTATION: rework must not run the plan stage", async () => {
    // Same setup as the reuse test but assert plan is skipped. If the route is
    // changed to omit resumeStage:"work" (or force status open), plan runs and
    // this fails.
    const { actorId, apiKey, ticket } = await seedTicket("Rework skips plan");
    await ensureSandbox(workdir, ticket.id);
    writeFileSync(join(sandboxRoot, ticket.id, "result.txt"), "first pass");
    await forgeCommit(ticket.id, "first work");
    await addComment(actorId, ticket.id, "The plan\nFiles: result.txt", "plan");
    await addComment(actorId, ticket.id, "- Critical: bug\nVERDICT: FAIL", "review");
    const t2 = await getTicket(ticket.id);
    await updateTicket(actorId, ticket.id, t2.version, { status: "planned" });
    await db.insert(forgeRuns).values({
      id: randomUUID(), ticketId: ticket.id, status: "rejected", stage: "review",
      planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
      startedAt: new Date(), finishedAt: new Date(),
    });
    setScript("work,review-pass", true);

    const h = { Authorization: `Bearer ${apiKey}` };
    const res = await app.request(`/forge/tickets/${ticket.id}/rework`, { method: "POST", headers: h });
    expect(res.status).toBe(201);
    const { runId } = await res.json();
    await awaitRun(runId);
    expect(getRunOutput(runId, 0)?.chunk).not.toContain("=== FORGE plan");
  });

  it("rework skips planning even when the body changed after the plan", async () => {
    const { actorId, apiKey, ticket } = await seedTicket("Rework skips plan even with body edit");
    await ensureSandbox(workdir, ticket.id);
    writeFileSync(join(sandboxRoot, ticket.id, "result.txt"), "first pass");
    await forgeCommit(ticket.id, "first work");
    await addComment(actorId, ticket.id, "The plan\nFiles: result.txt", "plan");
    await addComment(actorId, ticket.id, "- Critical: bug\nVERDICT: FAIL", "review");
    const t1 = await getTicket(ticket.id);
    await updateTicket(actorId, ticket.id, t1.version, { body: "Owner decision appended after plan" });
    const t2 = await getTicket(ticket.id);
    await updateTicket(actorId, ticket.id, t2.version, { status: "planned" });
    await db.insert(forgeRuns).values({
      id: randomUUID(), ticketId: ticket.id, status: "rejected", stage: "review",
      planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
      startedAt: new Date(), finishedAt: new Date(),
    });
    setScript("work,review-pass", true);

    const h = { Authorization: `Bearer ${apiKey}` };
    const res = await app.request(`/forge/tickets/${ticket.id}/rework`, { method: "POST", headers: h });
    expect(res.status).toBe(201);
    const { runId } = await res.json();
    await awaitRun(runId);
    expect(getRunOutput(runId, 0)?.chunk).not.toContain("=== FORGE plan");
  });

  it("rework with explicit workAgent/workModel uses them", async () => {
    enableSmartModel();
    await withSetting("forge.defaultModel.work", "fake:fast", async () => {
      const { apiKey, ticket } = await seedRejected("Rework explicit model");
      setScript("echo-argv,review-pass");
      const h = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
      const res = await app.request(`/forge/tickets/${ticket.id}/rework`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ workAgent: "fake", workModel: "smart" }),
      });
      expect(res.status).toBe(201);
      const { runId } = await res.json();
      await awaitRun(runId);
      const runs = await listRunsWithHistory(ticket.id);
      expect(runs.find((r) => r.id === runId)!.agents.work).toBe("fake:smart");
      const output = getRunOutput(runId, 0);
      expect(output?.chunk).toContain('"--model","smart"');
      expect(output?.chunk).not.toContain("=== FORGE plan");
    });
  });

  it("rework without the fields still uses auto", async () => {
    enableSmartModel();
    await withSetting("forge.defaultModel.work", "fake:smart", async () => {
      const { apiKey, ticket } = await seedRejected("Rework auto model");
      setScript("work,review-pass", true);
      const h = { Authorization: `Bearer ${apiKey}` };
      const res = await app.request(`/forge/tickets/${ticket.id}/rework`, {
        method: "POST",
        headers: h,
      });
      expect(res.status).toBe(201);
      const { runId } = await res.json();
      await awaitRun(runId);
      const runs = await listRunsWithHistory(ticket.id);
      expect(runs.find((r) => r.id === runId)!.agents.work).toBe("fake:smart");
    });
  });

  it("invalid values are rejected like /forge/pipeline rejects them", async () => {
    enableSmartModel();
    const { apiKey, ticket } = await seedRejected("Rework invalid values");
    const h = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
    const invalidPayloads = [
      { workAgent: 123 },
      { workAgent: "" },
      { workModel: 5 },
      { workAgent: "nope" },
      { workAgent: "fake", workModel: "nope" },
    ];
    for (const body of invalidPayloads) {
      const res = await app.request(`/forge/tickets/${ticket.id}/rework`, {
        method: "POST",
        headers: h,
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    expect(await hasActiveRun(ticket.id)).toBe(false);
    const runs = await listRunsWithHistory(ticket.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("rejected");
  });

  it("resume accepts picks and rejects invalid values with 400", async () => {
    enableSmartModel();
    const { apiKey, ticket } = await seedTicket("Resume picks");
    const h = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
    const badRes = await app.request(`/forge/tickets/${ticket.id}/resume`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ workAgent: "nope" }),
    });
    expect(badRes.status).toBe(400);

    setScript("plan,work,review-pass", true);
    const okRes = await app.request(`/forge/tickets/${ticket.id}/resume`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ planAgent: "fake", planModel: "smart" }),
    });
    expect(okRes.status).toBe(201);
    const { runId } = await okRes.json();
    await awaitRun(runId);
    const runs = await listRunsWithHistory(ticket.id);
    expect(runs.find((r) => r.id === runId)!.agents.plan).toBe("fake:smart");
  });

  it("base conflict rejects before the review agent runs; rework commits a merge and the next review passes", async () => {
    enableSmartModel();
    await withSetting("forge.defaultModel.work", "fake:fast", async () => {
      const { actorId, apiKey, ticket } = await seedRejected("Rework base conflict");
      writeFileSync(join(workdir, "result.txt"), "parallel ticket\n");
      execFileSync("git", ["add", "result.txt"], { cwd: workdir });
      execFileSync("git", ["commit", "-m", "parallel promote"], { cwd: workdir });
      const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workdir }).toString().trim();

      setScript("review-pass");
      const first = await startPipeline(actorId, loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG!), {
        ticketId: ticket.id, planAgent: "auto", workAgent: "auto", reviewAgent: "auto", resumeStage: "review",
      });
      await awaitRun(first.runId);
      expect(getRunOutput(first.runId, 0)?.status).toBe("rejected");
      expect(existsSync(counterFile)).toBe(false);
      const comments = await listComments(ticket.id);
      const last = comments[comments.length - 1];
      expect(last.kind).toBe("review");
      expect(last.body).toContain("result.txt");
      expect(last.body.trimEnd()).toMatch(/VERDICT: FAIL$/);
      expect((await getTicket(ticket.id)).status).toBe("planned");
      expect(listRuns().find((r) => r.id === first.runId)?.cause).toBe("base_conflict");

      process.env.FAKE_WRITE_PATH = "result.txt";
      setScript("work,review-pass");
      const res = await app.request(`/forge/tickets/${ticket.id}/rework`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` } });
      expect(res.status).toBe(201);
      const { runId } = await res.json();
      await awaitRun(runId);
      const out = getRunOutput(runId, 0);
      expect(out?.chunk).toContain("=== FORGE base sync: conflict (result.txt) ===");
      expect(out?.status).toBe("passed");
      expect(execFileSync("git", ["merge-base", "HEAD", `forge/${ticket.id}`], { cwd: workdir }).toString().trim()).toBe(base);
      expect(execFileSync("git", ["rev-list", "--parents", "-n", "1", "HEAD"], { cwd: join(sandboxRoot, ticket.id) }).toString().trim().split(" ")).toHaveLength(3);
      expect(listRuns().find((r) => r.id === runId)!.agents.work).toBe("fake:fast");
    });
  });
});
