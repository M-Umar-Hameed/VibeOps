import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { startPipeline, getRunOutput, awaitRun, stopRun, listRuns, resolveWorkdir } from "../src/forge/runs.js";
import { sandboxExists, branchName, promoteSandbox } from "../src/forge/sandbox.js";
import { createActor } from "../src/services/actors.js";
import { createProject, updateProjectRepo } from "../src/services/projects.js";
import { createTicket } from "../src/services/tickets.js";
import { updateTicket } from "../src/services/tickets.js";
import { addComment, listComments } from "../src/services/comments.js";
import { getTicket } from "../src/services/history.js";
import { getSetting, setSetting } from "../src/services/settings.js";
import { ConflictError } from "../src/services/errors.js";
import { db } from "../src/db/client.js";
import { forgeRuns } from "../src/db/schema.js";
import type { RelayConfig } from "../src/relay/config.js";

process.env.EMBED_PROVIDER = "fake";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(__dirname, "fixtures", "fake-agent.mjs");

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

async function seedTicket(title: string) {
  const { actor } = await createActor({ name: uniq("forge-actor"), kind: "human" });
  const project = await createProject({ key: uniq("forge-proj"), name: "Forge" });
  const ticket = await createTicket(actor.id, { projectId: project.id, title });
  return { actorId: actor.id, ticket };
}

let workdir: string;
let sandboxRoot: string;
let counterDir: string;
let counterFile: string;

beforeEach(() => {
  workdir = initRepo();
  sandboxRoot = mkdtempSync(join(tmpdir(), "forge-run-sbx-"));
  process.env.VIBEOPS_SANDBOX_ROOT = sandboxRoot;
  counterDir = mkdtempSync(join(tmpdir(), "forge-run-ctr-"));
  counterFile = join(counterDir, "counter.txt");
});

afterEach(() => {
  delete process.env.VIBEOPS_SANDBOX_ROOT;
  delete process.env.FAKE_SCRIPT;
  delete process.env.FAKE_COUNTER_FILE;
  delete process.env.FAKE_WRITE;
  rmSync(workdir, { recursive: true, force: true });
  rmSync(sandboxRoot, { recursive: true, force: true });
  rmSync(counterDir, { recursive: true, force: true });
});

function relayConfig(): RelayConfig {
  return {
    workdir,
    agents: {
      fake: {
        cmd: [process.execPath, FAKE_AGENT, "{prompt}", "--model", "{model}"],
        roles: ["plan", "work", "review"],
        models: [{ name: "fast", tier: "free", quality: 2 }, { name: "smart", tier: "expensive", quality: 5 }],
      },
    },
  };
}

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

// Persistence is fire-and-forget (settle() doesn't await the insert), so the
// row can land a tick or two after awaitRun resolves. Poll instead of racing.
async function waitForPersistedRun(runId: string, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    const [row] = await db.select().from(forgeRuns).where(eq(forgeRuns.id, runId));
    if (row && row.status !== "running") return row;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for persisted run ${runId}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("forge run manager", () => {
  it("happy path: PASS leaves ticket in review awaiting promote", async () => {
    const { actorId, ticket } = await seedTicket("Happy path");
    setScript("plan,work,review-pass", true);

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const finalTicket = await getTicket(ticket.id);
    expect(finalTicket.status).toBe("review");

    const comments = await listComments(ticket.id);
    expect(comments.filter((c) => c.kind === "plan")).toHaveLength(1);
    expect(comments.filter((c) => c.kind === "report")).toHaveLength(1);
    const review = comments.filter((c) => c.kind === "review");
    expect(review).toHaveLength(1);
    expect(review[0].body).toContain("VERDICT: PASS");

    expect(sandboxExists(ticket.id)).toBe(true);

    const output = getRunOutput(runId, 0);
    expect(output?.status).toBe("passed");
    expect(output?.chunk).toContain("=== FORGE plan");
    expect(output?.chunk).toContain("=== FORGE work");
    expect(output?.chunk).toContain("=== FORGE review");

    const persisted = await waitForPersistedRun(runId);
    expect(persisted.status).toBe("passed");
    expect(persisted.finishedAt).toBeTruthy();
  });

  it("FAIL verdict bounces to planned, sandbox kept", async () => {
    const { actorId, ticket } = await seedTicket("Fail path");
    setScript("plan,work,review-fail");

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    expect(getRunOutput(runId, 0)?.status).toBe("passed");
    expect((await getTicket(ticket.id)).status).toBe("planned");
    expect(sandboxExists(ticket.id)).toBe(true);
  });

  it("worker process failure bounces to planned", async () => {
    const { actorId, ticket } = await seedTicket("Exit path");
    setScript("plan,exit");

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    expect(getRunOutput(runId, 0)?.status).toBe("failed");
    expect((await getTicket(ticket.id)).status).toBe("planned");
    const report = [...(await listComments(ticket.id))].reverse().find((c) => c.kind === "report");
    expect(report?.body).toContain("worker failed");

    const persisted = await waitForPersistedRun(runId);
    expect(persisted.status).toBe("failed");
    expect(persisted.finishedAt).toBeTruthy();
  });

  it("second pipeline on the same ticket rejects with ConflictError", async () => {
    const { actorId, ticket } = await seedTicket("Race path");
    setScript("slow");

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await expect(startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    })).rejects.toThrow(ConflictError);

    await awaitRun(runId);
  }, 15_000);

  it("planned ticket skips the plan stage", async () => {
    const { actorId, ticket } = await seedTicket("Skip plan path");
    await addComment(actorId, ticket.id, "seeded plan", "plan");
    await updateTicket(actorId, ticket.id, ticket.version, { status: "planned" });
    setScript("work,review-pass");

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const output = getRunOutput(runId, 0);
    expect(output?.chunk).not.toContain("=== FORGE plan");
    const comments = await listComments(ticket.id);
    expect(comments.filter((c) => c.kind === "plan")).toHaveLength(1);
  });

  it("output polling with offset", async () => {
    const { actorId, ticket } = await seedTicket("Polling path");
    setScript("plan,work,review-pass", true);

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const full = getRunOutput(runId, 0);
    expect(full?.chunk.length).toBeGreaterThan(0);
    expect(full?.next).toBe(full?.chunk.length);

    const empty = getRunOutput(runId, full!.next);
    expect(empty?.chunk).toBe("");
    expect(empty?.next).toBe(full!.next);
  });

  it("redaction applied to streamed output", async () => {
    const { actorId, ticket } = await seedTicket("Leaky path");
    setScript("leaky");

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const output = getRunOutput(runId, 0);
    expect(output?.chunk).toContain("[redacted]");
    expect(output?.chunk).not.toContain("sk-abcdefghij0123456789");

    // Comments are the durable record: they must be redacted too.
    const comments = await listComments(ticket.id);
    const bodies = comments.map((c) => c.body).join("\n");
    expect(bodies).not.toContain("sk-abcdefghij0123456789");
  });

  it("stop kills the in-flight work agent instead of waiting for its timeout", async () => {
    const { actorId, ticket } = await seedTicket("Stop path");
    setScript("plan,slow");

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });

    await waitForStage(runId, "work");
    expect(stopRun(runId)).toBe(true);
    await awaitRun(runId);

    expect(getRunOutput(runId, 0)?.status).toBe("stopped");
    expect((await getTicket(ticket.id)).status).toBe("planned");
    const summary = listRuns().find((r) => r.id === runId);
    expect(summary?.finishedAt).toBeTruthy();
  }, 15_000);

  it("stopRun returns false for an unknown or already-settled run", async () => {
    expect(stopRun("no-such-run")).toBe(false);

    const { actorId, ticket } = await seedTicket("Already settled path");
    setScript("plan,exit");
    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    expect(stopRun(runId)).toBe(false);
  });

  it("explicit workModel is recorded as an agent:model composite", async () => {
    const { actorId, ticket } = await seedTicket("Model select path");
    setScript("plan,work,review-pass", true);

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake", workModel: "fast",
    });
    await awaitRun(runId);

    expect(getRunOutput(runId, 0)?.status).toBe("passed");
    expect(listRuns().find((r) => r.id === runId)?.agents.work).toBe("fake:fast");
  });

  it("auto agent picks resolve via the configured routing strategy", async () => {
    const { actorId, ticket } = await seedTicket("Auto cheapest path");
    const priorStrategy = await getSetting("ai.routing_strategy");
    await setSetting("ai.routing_strategy", "cheapest-first");
    setScript("plan,work,review-pass", true);
    try {
      const { runId } = await startPipeline(actorId, relayConfig(), {
        ticketId: ticket.id, planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
      });
      await awaitRun(runId);

      expect(getRunOutput(runId, 0)?.status).toBe("passed");
      const summary = listRuns().find((r) => r.id === runId);
      // cheapest-first: lowest tier wins for every role -> the free "fast" model.
      expect(summary?.agents).toEqual({ plan: "fake:fast", work: "fake:fast", review: "fake:fast" });
    } finally {
      await setSetting("ai.routing_strategy", priorStrategy ?? "balanced");
    }
  });

  it("commProfile setting does not break the pipeline", async () => {
    const { actorId, ticket } = await seedTicket("Comm profile path");
    const prior = await getSetting("agents.commProfile");
    await setSetting("agents.commProfile", "caveman");
    setScript("plan,work,review-pass", true);
    try {
      const { runId } = await startPipeline(actorId, relayConfig(), {
        ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
      });
      await awaitRun(runId);
      expect(getRunOutput(runId, 0)?.status).toBe("passed");
    } finally {
      await setSetting("agents.commProfile", prior ?? "off");
    }
  });

  it("pipeline sandboxes the ticket's OWN project repo, not config.workdir, and promote merges into it", async () => {
    const projectRepo = initRepo();
    const { actor } = await createActor({ name: uniq("forge-actor"), kind: "human" });
    const project = await createProject({ key: uniq("forge-proj"), name: "Forge" });
    await updateProjectRepo(project.id, projectRepo);
    const ticket = await createTicket(actor.id, { projectId: project.id, title: "Own repo path" });
    setScript("plan,work,review-pass", true);

    const { runId } = await startPipeline(actor.id, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);
    expect(getRunOutput(runId, 0)?.status).toBe("passed");

    const branch = branchName(ticket.id);
    const ownBranches = execFileSync("git", ["branch", "--list", branch], { cwd: projectRepo }).toString();
    expect(ownBranches).toContain(branch);
    const configWorkdirBranches = execFileSync("git", ["branch", "--list", branch], { cwd: workdir }).toString();
    expect(configWorkdirBranches.trim()).toBe("");

    const resolved = await resolveWorkdir(project.id, relayConfig());
    expect(resolved).toBe(projectRepo);
    await promoteSandbox(resolved, ticket.id);
    expect(existsSync(join(projectRepo, "forge-made.txt"))).toBe(true);
    expect(sandboxExists(ticket.id)).toBe(false);

    rmSync(projectRepo, { recursive: true, force: true });
  });

  it("pipeline 409s when the project's repoPath is set but not a git repo", async () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), "forge-run-nongit-"));
    const { actor } = await createActor({ name: uniq("forge-actor"), kind: "human" });
    const project = await createProject({ key: uniq("forge-proj"), name: "Forge" });
    await updateProjectRepo(project.id, nonGitDir);
    const ticket = await createTicket(actor.id, { projectId: project.id, title: "Non-git repo" });
    setScript("plan,work,review-pass", true);

    await expect(startPipeline(actor.id, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    })).rejects.toThrow(ConflictError);

    rmSync(nonGitDir, { recursive: true, force: true });
  });
});
