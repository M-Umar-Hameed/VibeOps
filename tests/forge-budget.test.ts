import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { startPipeline, awaitRun } from "../src/forge/runs.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { createTicket } from "../src/services/tickets.js";
import { getSetting, setSetting } from "../src/services/settings.js";
import { ConflictError } from "../src/services/errors.js";
import { db } from "../src/db/client.js";
import { aiUsageLogs } from "../src/db/schema.js";
import type { RelayConfig } from "../src/relay/config.js";

process.env.EMBED_PROVIDER = "fake";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(__dirname, "fixtures", "fake-agent.mjs");

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-budget-base-"));
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
  const { actor } = await createActor({ name: uniq("budget-actor"), kind: "human" });
  const project = await createProject({ key: uniq("budget-proj"), name: "Forge Budget" });
  const ticket = await createTicket(actor.id, { projectId: project.id, title });
  return { actorId: actor.id, ticket };
}

let workdir: string;
let sandboxRoot: string;
let counterDir: string;
let counterFile: string;

beforeEach(() => {
  workdir = initRepo();
  sandboxRoot = mkdtempSync(join(tmpdir(), "forge-budget-sbx-"));
  process.env.VIBEOPS_SANDBOX_ROOT = sandboxRoot;
  counterDir = mkdtempSync(join(tmpdir(), "forge-budget-ctr-"));
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

function relayConfig(): RelayConfig {
  return {
    workdir,
    agents: {
      fake: {
        cmd: [process.execPath, FAKE_AGENT, "{prompt}"],
        roles: ["plan", "work", "review"],
      },
    },
  };
}

function setScript(script: string): void {
  process.env.FAKE_SCRIPT = script;
  process.env.FAKE_COUNTER_FILE = counterFile;
}

describe("forge pipeline budget enforcement", () => {
  it("rejects when per-ticket budget is exceeded, proceeds with force:true", async () => {
    const { actorId, ticket } = await seedTicket("Per-ticket budget");
    const prior = await getSetting("ai.budget.perTicketTokens");
    await setSetting("ai.budget.perTicketTokens", "1000");

    try {
      await db.insert(aiUsageLogs).values({
        provider: "test", model: "test", tokens: 1500, ticketId: ticket.id, actorId, durationMs: 100,
      });

      setScript("plan,work,review-pass");
      
      await expect(startPipeline(actorId, relayConfig(), {
        ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
      })).rejects.toThrow(ConflictError);
      
      await expect(startPipeline(actorId, relayConfig(), {
        ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
      })).rejects.toThrow(/per-ticket token cap exceeded/);

      const { runId } = await startPipeline(actorId, relayConfig(), {
        ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake", force: true,
      });
      await awaitRun(runId);
    } finally {
      await setSetting("ai.budget.perTicketTokens", prior ?? "");
    }
  });

  it("rejects when per-day budget is exceeded, proceeds with force:true", async () => {
    const { actorId, ticket } = await seedTicket("Per-day budget");
    const prior = await getSetting("ai.budget.perDayTokens");
    await setSetting("ai.budget.perDayTokens", "2000");

    try {
      await db.insert(aiUsageLogs).values({
        provider: "test", model: "test", tokens: 2500, ticketId: ticket.id, actorId, durationMs: 100,
        createdAt: new Date(),
      });

      setScript("plan,work,review-pass");

      await expect(startPipeline(actorId, relayConfig(), {
        ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
      })).rejects.toThrow(ConflictError);

      await expect(startPipeline(actorId, relayConfig(), {
        ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
      })).rejects.toThrow(/per-day token cap exceeded/);

      const { runId } = await startPipeline(actorId, relayConfig(), {
        ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake", force: true,
      });
      await awaitRun(runId);
    } finally {
      await setSetting("ai.budget.perDayTokens", prior ?? "");
    }
  });

  it("unset caps never block", async () => {
    const { actorId, ticket } = await seedTicket("Unset budget");
    const priorTicket = await getSetting("ai.budget.perTicketTokens");
    const priorDay = await getSetting("ai.budget.perDayTokens");
    
    await setSetting("ai.budget.perTicketTokens", "");
    await setSetting("ai.budget.perDayTokens", "");

    try {
      await db.insert(aiUsageLogs).values({
        provider: "test", model: "test", tokens: 50000, ticketId: ticket.id, actorId, durationMs: 100,
      });

      setScript("plan,work,review-pass");

      const { runId } = await startPipeline(actorId, relayConfig(), {
        ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
      });
      await awaitRun(runId);
    } finally {
      await setSetting("ai.budget.perTicketTokens", priorTicket ?? "");
      await setSetting("ai.budget.perDayTokens", priorDay ?? "");
    }
  });
});
