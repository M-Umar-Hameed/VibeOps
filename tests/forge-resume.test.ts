import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { markInterruptedRuns, awaitRun, getRunOutput, stopRun, startPipeline } from "../src/forge/runs.js";
import { loadRelayConfig } from "../src/relay/config.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { createTicket, updateTicket } from "../src/services/tickets.js";
import { getTicket } from "../src/services/history.js";
import { app } from "../src/api/app.js";
import { db } from "../src/db/client.js";
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

beforeEach(() => {
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
    
    stopRun(runId);
    await awaitRun(runId);
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
});
