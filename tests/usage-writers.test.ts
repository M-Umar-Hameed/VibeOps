import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { eq, like } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { aiUsageLogs, agentSessions } from "../src/db/schema.js";
import { startPipeline, awaitRun } from "../src/forge/runs.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { createTicket } from "../src/services/tickets.js";
import { getTicket } from "../src/services/history.js";
import { app } from "../src/api/app.js";
import type { RelayConfig } from "../src/relay/config.js";

process.env.EMBED_PROVIDER = "fake";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(__dirname, "fixtures", "fake-agent.mjs");

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "usage-run-base-"));
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
  const { actor } = await createActor({ name: uniq("usage-actor"), kind: "human" });
  const project = await createProject({ key: uniq("usage-proj"), name: "Usage" });
  const ticket = await createTicket(actor.id, { projectId: project.id, title });
  return { actorId: actor.id, ticket };
}

let workdir: string;
let sandboxRoot: string;
let counterDir: string;
let counterFile: string;

beforeEach(() => {
  workdir = initRepo();
  sandboxRoot = mkdtempSync(join(tmpdir(), "usage-run-sbx-"));
  process.env.VIBEOPS_SANDBOX_ROOT = sandboxRoot;
  counterDir = mkdtempSync(join(tmpdir(), "usage-run-ctr-"));
  counterFile = join(counterDir, "counter.txt");
});

afterEach(() => {
  delete process.env.VIBEOPS_SANDBOX_ROOT;
  delete process.env.FAKE_SCRIPT;
  delete process.env.FAKE_COUNTER_FILE;
  rmSync(workdir, { recursive: true, force: true });
  rmSync(sandboxRoot, { recursive: true, force: true });
  rmSync(counterDir, { recursive: true, force: true });
});

// ai_usage_logs/agent_sessions are never truncated between runs (unlike
// embeddings, see tests/global-setup.ts) and the suite runs test files in
// parallel against one shared Postgres instance. A unique agent name per test
// keeps each test's rows queryable in isolation.
function relayConfig(agentName: string): RelayConfig {
  return {
    workdir,
    agents: { [agentName]: { cmd: [process.execPath, FAKE_AGENT, "{prompt}"], roles: ["plan", "work", "review"] } },
  };
}

function setScript(script: string): void {
  process.env.FAKE_SCRIPT = script;
  process.env.FAKE_COUNTER_FILE = counterFile;
}

describe("usage writers", () => {
  it("happy path writes plan/work/review usage rows and passed sessions", async () => {
    const { actorId, ticket } = await seedTicket("Usage happy path");
    const agentName = uniq("agent");
    setScript("plan,work,review-pass");

    const { runId } = await startPipeline(actorId, relayConfig(agentName), {
      ticketId: ticket.id, planAgent: agentName, workAgent: agentName, reviewAgent: agentName,
    });
    await awaitRun(runId);
    expect((await getTicket(ticket.id)).status).toBe("review");

    const usageRows = await db.select().from(aiUsageLogs).where(eq(aiUsageLogs.provider, agentName));
    const roles = usageRows.map((r) => r.model).sort();
    expect(roles).toEqual(["plan", "review", "work"]);
    for (const row of usageRows) {
      expect(row.tokens).toBeGreaterThan(0);
      expect(row.ticketId).toBe(ticket.id);
      expect(row.actorId).toBe(actorId);
      expect(row.durationMs).toBeGreaterThan(0);
    }

    const sessionRows = await db.select().from(agentSessions)
      .where(like(agentSessions.agentName, `%:${agentName}`));
    expect(sessionRows).toHaveLength(3);
    for (const row of sessionRows) {
      expect(row.status).toBe("passed");
      expect(+row.updatedAt).toBeGreaterThanOrEqual(+row.createdAt);
    }
  });

  it("worker process failure still writes a failed usage/session row", async () => {
    const { actorId, ticket } = await seedTicket("Usage failure path");
    const agentName = uniq("agent");
    setScript("plan,exit");

    const { runId } = await startPipeline(actorId, relayConfig(agentName), {
      ticketId: ticket.id, planAgent: agentName, workAgent: agentName, reviewAgent: agentName,
    });
    await awaitRun(runId);
    expect((await getTicket(ticket.id)).status).toBe("planned");

    // review never runs (work bounces the pipeline), but a usage row is still
    // logged for the failed work stage: ai_usage_logs has no "ok" column, so
    // failure is only visible via the session status below.
    const usageRows = await db.select().from(aiUsageLogs).where(eq(aiUsageLogs.provider, agentName));
    expect(usageRows.map((r) => r.model).sort()).toEqual(["plan", "work"]);

    const sessionRows = await db.select().from(agentSessions)
      .where(like(agentSessions.agentName, `%:${agentName}`));
    const planSession = sessionRows.find((r) => r.agentName === `plan:${agentName}`);
    const workSession = sessionRows.find((r) => r.agentName === `work:${agentName}`);
    expect(planSession?.status).toBe("passed");
    expect(workSession?.status).toBe("failed");
  });

  it("GET /system/ai-usage surfaces the written rows", async () => {
    const { actorId, ticket } = await seedTicket("Usage endpoint path");
    const agentName = uniq("agent");
    setScript("plan,work,review-pass");

    const { runId } = await startPipeline(actorId, relayConfig(agentName), {
      ticketId: ticket.id, planAgent: agentName, workAgent: agentName, reviewAgent: agentName,
    });
    await awaitRun(runId);

    const { apiKey } = await createActor({ name: uniq("usage-admin"), kind: "human", role: "admin" });
    const res = await app.request("/system/ai-usage", { headers: { Authorization: `Bearer ${apiKey}` } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.usage.length).toBeGreaterThan(0);
    expect(data.agents.length).toBeGreaterThan(0);
    expect(data.overview.totalTokens).toBeGreaterThan(0);
    
    const myTicket = data.perTicket.find((t: any) => t.ticketId === ticket.id);
    expect(myTicket).toBeDefined();
    expect(myTicket.tokens).toBeGreaterThan(0);
    expect(myTicket.title).toBe("Usage endpoint path");
  });
});
