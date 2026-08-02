import { runDoctor, type ProbeStatus } from "../src/relay/doctor.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { 
  startPipeline, 
  stopRun, 
  listRuns, 
  listRunsWithHistory,
  getRunOutput, 
  hasActiveRun, 
  markInterruptedRuns,
  resolveWorkdir,
  awaitRun,
  latestRunPolicy
} from "../src/forge/runs.js";
import { sandboxExists, branchName, promoteSandbox } from "../src/forge/sandbox.js";
import { createActor } from "../src/services/actors.js";
import { createProject, updateProjectRepo } from "../src/services/projects.js";
import { createTicket, updateTicket } from "../src/services/tickets.js";
import * as ticketsSvc from "../src/services/tickets.js";
import * as knowledgeSvc from "../src/services/knowledge.js";
import { addComment, listComments } from "../src/services/comments.js";
import { getTicket } from "../src/services/history.js";
import { withSetting, withSettings } from "./helpers/settings.js";
import { ConflictError, StaleVersionError } from "../src/services/errors.js";
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
  // Pipelines start via admin-gated routes in production; verification markers
  // are only trusted on admin-authored pipeline comments.
  const { actor } = await createActor({ name: uniq("forge-actor"), kind: "human", role: "admin" });
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
  delete process.env.FAKE_WRITE_PATH;
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
  it("knowledge search is scoped to the ticket's project", async () => {
    const spy = vi.spyOn(knowledgeSvc, "searchKnowledge");
    const { actorId, ticket } = await seedTicket("Scoped knowledge");
    setScript("plan,work,review-pass", true);

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    expect(spy).toHaveBeenCalled();
    for (const call of spy.mock.calls) {
      expect(call[1]).toMatchObject({ projectId: ticket.projectId });
    }
    spy.mockRestore();
  });

  it("empty spec: plan text is written into the ticket body", async () => {
    const { actorId, ticket } = await seedTicket("Spec from plan");
    expect(ticket.body).toBe("");
    setScript("plan,work,review-pass", true);

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const finalTicket = await getTicket(ticket.id);
    const comments = await listComments(ticket.id);
    const planComment = comments.find((c) => c.kind === "plan");
    expect(comments.filter((c) => c.kind === "plan")).toHaveLength(1);
    expect(finalTicket.body.trim().length).toBeGreaterThan(0);
    expect(finalTicket.body).toBe(planComment!.body); // body === plan output (both redacted res.output)

    expect(getRunOutput(runId, 0)?.chunk).toContain("=== FORGE spec populated from plan ===");
  });

  it("non-empty spec: body is left unchanged", async () => {
    const { actorId, ticket } = await seedTicket("Has a spec");
    const withBody = await updateTicket(actorId, ticket.id, ticket.version, { body: "human spec" });
    setScript("plan,work,review-pass", true);

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    expect((await getTicket(ticket.id)).body).toBe("human spec");
    expect(getRunOutput(runId, 0)?.chunk).not.toContain("spec populated from plan");
    void withBody;
  });

  it("spec write failure does not fail the run; work stage still executes", async () => {
    const { actorId, ticket } = await seedTicket("Spec write boom");
    setScript("plan,work,review-pass", true);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const realUpdate = ticketsSvc.updateTicket;
    const spy = vi.spyOn(ticketsSvc, "updateTicket").mockImplementation(
      async (actor: string, id: string, ver: number, patch: any) => {
        if (patch.body !== undefined) throw new StaleVersionError(ver, ver + 1); // only the spec write
        return realUpdate(actor, id, ver, patch); // status transitions run normally
      },
    );

    try {
      const { runId } = await startPipeline(actorId, relayConfig(), {
        ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
      });
      await awaitRun(runId);

      const finalTicket = await getTicket(ticket.id);
      expect(finalTicket.status).toBe("review");       // reached work + review despite spec-write failure
      expect(finalTicket.body).toBe("");               // write was rejected
      const comments = await listComments(ticket.id);
      expect(comments.filter((c) => c.kind === "report")).toHaveLength(1); // work stage executed
    } finally {
      spy.mockRestore();
    }
  });

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
    expect(output?.chunk).not.toContain("=== FORGE checks ===");

    const persisted = await waitForPersistedRun(runId);
    expect(persisted.status).toBe("passed");
    expect(persisted.finishedAt).toBeTruthy();
  });

  it("FAIL verdict settles rejected, bounces to planned, sandbox kept", async () => {
    const { actorId, ticket } = await seedTicket("Fail path");
    setScript("plan,work,review-fail");

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    expect(getRunOutput(runId, 0)?.status).toBe("rejected");
    expect((await getTicket(ticket.id)).status).toBe("planned");
    expect(sandboxExists(ticket.id)).toBe(true);

    const persisted = await waitForPersistedRun(runId);
    expect(persisted.status).toBe("rejected");
  });

  it("executes project checks and feeds failures to the review prompt without hard-failing the pipeline", async () => {
    const { actorId, ticket } = await seedTicket("Checks path");
    
    // Extend base repo
    const g = (...a: string[]) => execFileSync("git", a, { cwd: workdir });
    writeFileSync(join(workdir, "package.json"), JSON.stringify({ scripts: { typecheck: "node typecheck.js" } }));
    writeFileSync(join(workdir, "typecheck.js"), `console.log("TS-FAKE-9999 boom"); process.exit(1);`);
    g("add", "-A");
    g("commit", "-m", "add check");

    setScript("plan,work,echo-prompt");

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const output = getRunOutput(runId, 0);
    expect(output?.chunk).toContain("=== FORGE checks ===");
    expect(output?.chunk).toContain("exit 1");

    const comments = await listComments(ticket.id);
    const review = comments.filter((c) => c.kind === "review").pop();
    expect(review?.body).toContain("CHECKS");
    expect(review?.body).toContain("exit 1");
    expect(review?.body).toContain("TS-FAKE-9999");
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

  it("work stage editing a protected path records a durable violation without forcing the verdict", async () => {
    const { actorId, ticket } = await seedTicket("Protected path violation");
    process.env.FAKE_WRITE_PATH = "vitest.config.ts";
    setScript("plan,work,review-pass");

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const output = getRunOutput(runId, 0);
    expect(output?.chunk).toContain("=== FORGE protected-paths ===");
    expect(output?.chunk).toContain("vitest.config.ts");

    // The durable run-row gate — not the review verdict — blocks promote now.
    const policy = await latestRunPolicy(ticket.id);
    expect(policy?.paths).toEqual(["vitest.config.ts"]);
    expect(policy?.waived).toBe(false);
    expect((await getTicket(ticket.id)).status).toBe("review");
  });

  it("ALLOW-PROTECTED in the ticket body lets a protected edit pass, allowance echoed", async () => {
    const { actorId, ticket } = await seedTicket("Protected path allowed");
    await updateTicket(actorId, ticket.id, ticket.version,
      { body: "Fix the test runner.\nALLOW-PROTECTED: vitest.config.ts" });
    process.env.FAKE_WRITE_PATH = "vitest.config.ts";
    setScript("plan,work,review-pass");

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const output = getRunOutput(runId, 0);
    expect(output?.chunk).toContain("ALLOW-PROTECTED honoured: vitest.config.ts");
    const review = (await listComments(ticket.id)).filter((c) => c.kind === "review").pop();
    expect(review?.body).toContain("VERDICT: PASS");
    expect(review?.body).not.toContain("PROTECTED-PATH VIOLATION");
    expect((await getTicket(ticket.id)).status).toBe("review"); // awaiting promote
  });

  it("a run touching only src/ is unaffected by the protected-path gate", async () => {
    const { actorId, ticket } = await seedTicket("Ordinary src path");
    process.env.FAKE_WRITE_PATH = "src/feature.ts";
    setScript("plan,work,review-pass");

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const output = getRunOutput(runId, 0);
    expect(output?.chunk).not.toContain("=== FORGE protected-paths ===");
    const review = (await listComments(ticket.id)).filter((c) => c.kind === "review").pop();
    expect(review?.body).toContain("VERDICT: PASS");
    expect(review?.body).not.toContain("PROTECTED-PATH VIOLATION");
    expect((await getTicket(ticket.id)).status).toBe("review");
  });

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
    setScript("plan,work,review-pass", true);
    await withSettings({
      "ai.routing_strategy": "cheapest-first",
      "forge.defaultModel.plan": "",
      "forge.defaultModel.work": "",
      "forge.defaultModel.review": "",
    }, async () => {
      const { runId } = await startPipeline(actorId, relayConfig(), {
        ticketId: ticket.id, planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
      });
      await awaitRun(runId);

      expect(getRunOutput(runId, 0)?.status).toBe("passed");
      const summary = listRuns().find((r) => r.id === runId);
      // cheapest-first: lowest tier wins for every role -> the free "fast" model.
      expect(summary?.agents).toEqual({ plan: "fake:fast", work: "fake:fast", review: "fake:fast" });
    });
  });

  it("effort=quick resolves free-tier model for all auto roles regardless of global strategy", async () => {
    const { actorId, ticket } = await seedTicket("Effort quick path");
    setScript("plan,work,review-pass", true);
    await withSetting("ai.routing_strategy", "quality-first", async () => {
      const { runId } = await startPipeline(actorId, relayConfig(), {
        ticketId: ticket.id, planAgent: "auto", workAgent: "auto", reviewAgent: "auto", effort: "quick",
      });
      await awaitRun(runId);
      const summary = listRuns().find((r) => r.id === runId);
      expect(summary?.agents).toEqual({ plan: "fake:fast", work: "fake:fast", review: "fake:fast" });
      expect(summary?.effort).toBe("quick");
    });
  });

  it("effort=quick falls back to cheapest when no free-tier model exists", async () => {
    const { actorId, ticket } = await seedTicket("Effort quick fallback");
    setScript("plan,work,review-pass", true);
    const config = relayConfig();
    config.agents.fake.models = [
      { name: "mid", tier: "cheap", quality: 3 },
      { name: "smart", tier: "expensive", quality: 5 },
    ];
    const { runId } = await startPipeline(actorId, config, {
      ticketId: ticket.id, planAgent: "auto", workAgent: "auto", reviewAgent: "auto", effort: "quick",
    });
    await awaitRun(runId);
    expect(listRuns().find((r) => r.id === runId)?.agents)
      .toEqual({ plan: "fake:mid", work: "fake:mid", review: "fake:mid" });
  });

  it("effort=max resolves quality-first for all auto roles", async () => {
    const { actorId, ticket } = await seedTicket("Effort max path");
    setScript("plan,work,review-pass", true);
    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "auto", workAgent: "auto", reviewAgent: "auto", effort: "max",
    });
    await awaitRun(runId);
    const summary = listRuns().find((r) => r.id === runId);
    expect(summary?.agents).toEqual({ plan: "fake:smart", work: "fake:smart", review: "fake:smart" });
    expect(summary?.effort).toBe("max");
  });

  it("explicit workModel override beats effort", async () => {
    const { actorId, ticket } = await seedTicket("Effort vs explicit");
    setScript("plan,work,review-pass", true);
    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "auto", workAgent: "fake", reviewAgent: "auto",
      workModel: "smart", effort: "quick",
    });
    await awaitRun(runId);
    const summary = listRuns().find((r) => r.id === runId);
    expect(summary?.agents.work).toBe("fake:smart");
    expect(summary?.agents.plan).toBe("fake:fast");
  });

  it("effort persists to forge_runs and listRunsWithHistory exposes it", async () => {
    const { actorId, ticket } = await seedTicket("Effort persistence");
    setScript("plan,work,review-pass", true);
    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake", effort: "max",
    });
    await awaitRun(runId);
    const list = await listRunsWithHistory();
    expect(list.find((r) => r.id === runId)?.effort).toBe("max");
  });

  it("forge.defaultModel.<role> resolves an auto role, overriding routing strategy", async () => {
    const { actorId, ticket } = await seedTicket("Default model path");
    setScript("plan,work,review-pass", true);
    await withSettings({
      "ai.routing_strategy": "cheapest-first",
      "forge.defaultModel.plan": "fake:smart",
    }, async () => {
      const { runId } = await startPipeline(actorId, relayConfig(), {
        ticketId: ticket.id, planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
      });
      await awaitRun(runId);
      const summary = listRuns().find((r) => r.id === runId);
      // plan follows the saved default; work/review still resolve cheapest-first.
      expect(summary?.agents).toEqual({ plan: "fake:smart", work: "fake:fast", review: "fake:fast" });
    });
  });

  it("explicit planModel in the request beats the saved default", async () => {
    const { actorId, ticket } = await seedTicket("Default vs explicit");
    setScript("plan,work,review-pass", true);
    await withSetting("forge.defaultModel.plan", "fake:smart", async () => {
      const { runId } = await startPipeline(actorId, relayConfig(), {
        ticketId: ticket.id, planAgent: "fake", planModel: "fast", workAgent: "fake", reviewAgent: "fake",
      });
      await awaitRun(runId);
      expect(listRuns().find((r) => r.id === runId)?.agents.plan).toBe("fake:fast");
    });
  });

  it("effort=max beats the saved default", async () => {
    const { actorId, ticket } = await seedTicket("Default vs effort");
    setScript("plan,work,review-pass", true);
    await withSetting("forge.defaultModel.plan", "fake:fast", async () => {
      const { runId } = await startPipeline(actorId, relayConfig(), {
        ticketId: ticket.id, planAgent: "auto", workAgent: "auto", reviewAgent: "auto", effort: "max",
      });
      await awaitRun(runId);
      // max => quality-first everywhere; the fast default is ignored.
      expect(listRuns().find((r) => r.id === runId)?.agents.plan).toBe("fake:smart");
    });
  });

  it("commProfile setting does not break the pipeline", async () => {
    const { actorId, ticket } = await seedTicket("Comm profile path");
    setScript("plan,work,review-pass", true);
    await withSetting("agents.commProfile", "caveman", async () => {
      const { runId } = await startPipeline(actorId, relayConfig(), {
        ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
      });
      await awaitRun(runId);
      expect(getRunOutput(runId, 0)?.status).toBe("passed");
    });
  });

  it("pipeline sandboxes the ticket's OWN project repo, not config.workdir, and promote merges into it", async () => {
    const projectRepo = initRepo();
    // Pipelines start via admin-gated routes in production; verification markers
  // are only trusted on admin-authored pipeline comments.
  const { actor } = await createActor({ name: uniq("forge-actor"), kind: "human", role: "admin" });
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
    // Pipelines start via admin-gated routes in production; verification markers
  // are only trusted on admin-authored pipeline comments.
  const { actor } = await createActor({ name: uniq("forge-actor"), kind: "human", role: "admin" });
    const project = await createProject({ key: uniq("forge-proj"), name: "Forge" });
    await updateProjectRepo(project.id, nonGitDir);
    const ticket = await createTicket(actor.id, { projectId: project.id, title: "Non-git repo" });
    setScript("plan,work,review-pass", true);

    await expect(startPipeline(actor.id, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    })).rejects.toThrow(ConflictError);

    rmSync(nonGitDir, { recursive: true, force: true });
  });

  it("pipeline prompt includes a CHANGE REQUEST comment when present", async () => {
    const { actorId, ticket } = await seedTicket("Change Request path");
    await updateTicket(actorId, ticket.id, ticket.version, { status: "planned" });
    await addComment(actorId, ticket.id, "seeded plan", "plan");
    await addComment(actorId, ticket.id, "CHANGE REQUEST:\nFix the typo", "comment");

    // The fake-agent will echo the prompt so we can inspect it.
    // It will echo and exit 0. We'll wait for the pipeline to settle.
    setScript("echo-prompt");
    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const output = getRunOutput(runId, 0);
    expect(output?.chunk).toContain("Comments since last plan:");
    expect(output?.chunk).toContain("CHANGE REQUEST:");
    expect(output?.chunk).toContain("Fix the typo");
  });

  it("keeps the NEWEST change request when the budget cannot hold them all", async () => {
    const { actorId, ticket } = await seedTicket("Change Request budget");
    await updateTicket(actorId, ticket.id, ticket.version, { status: "planned" });
    await addComment(actorId, ticket.id, "seeded plan", "plan");
    // Oldest-first joining used to drop the latest feedback entirely, so a
    // rework silently repeated the previous pass. Newest must survive.
    await addComment(actorId, ticket.id, `CHANGE REQUEST:\nOLD-MARKER ${"x".repeat(13_000)}`, "comment");
    await addComment(actorId, ticket.id, "CHANGE REQUEST:\nNEW-MARKER fix the test, not the source", "comment");

    setScript("echo-prompt");
    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const output = getRunOutput(runId, 0);
    expect(output?.chunk).toContain("NEW-MARKER");
    expect(output?.chunk).not.toContain("OLD-MARKER");
    expect(output?.chunk).toContain("older comment(s) omitted");
  });

  it("an unmarked human comment reaches the worker (no CHANGE REQUEST prefix required)", async () => {
    const { actorId, ticket } = await seedTicket("Unmarked comment reaches worker");
    await updateTicket(actorId, ticket.id, ticket.version, { status: "planned" });
    await addComment(actorId, ticket.id, "seeded plan", "plan");
    // Live incident: a "Supervisor addendum" with no marker was silently dropped.
    await addComment(actorId, ticket.id, "Supervisor addendum: also cover the protected-path test", "comment");

    setScript("echo-prompt");
    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const output = getRunOutput(runId, 0);
    expect(output?.chunk).toContain("Comments since last plan:");
    expect(output?.chunk).toContain("Supervisor addendum: also cover the protected-path test");
    expect(output?.chunk).toContain("<UNTRUSTED label=\"ticket-comments\">");
  });

  it("an excluded comment is reported in the run output with counts", async () => {
    const { actorId, ticket } = await seedTicket("Excluded comment reported");
    await updateTicket(actorId, ticket.id, ticket.version, { status: "planned" });
    await addComment(actorId, ticket.id, "seeded plan", "plan");
    // Older comment overflows the 12k budget on its own -> excluded. Newer kept.
    await addComment(actorId, ticket.id, `OLD ${"x".repeat(13_000)}`, "comment");
    await addComment(actorId, ticket.id, "NEW short guidance", "comment");

    setScript("echo-prompt");
    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const output = getRunOutput(runId, 0);
    // Visibility: run output states considered/included/omitted counts.
    expect(output?.chunk).toContain("2 considered, 1 included, 1 omitted for length");
    // Kept comment reaches the prompt; excluded one does not.
    expect(output?.chunk).toContain("NEW short guidance");
    expect(output?.chunk).not.toContain(`OLD ${"x".repeat(13_000)}`);
  });

  it("agent-authored comments are not treated as guidance", async () => {
    const { actorId, ticket } = await seedTicket("Agent comments excluded");
    await updateTicket(actorId, ticket.id, ticket.version, { status: "planned" });
    await addComment(actorId, ticket.id, "seeded plan", "plan");
    // A report written after the plan must NOT be injected as human guidance.
    await addComment(actorId, ticket.id, "REPORTONLY-MARKER worker report body", "report");

    setScript("echo-prompt");
    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const output = getRunOutput(runId, 0);
    expect(output?.chunk).not.toContain("Comments since last plan:");
    expect(output?.chunk).not.toContain("REPORTONLY-MARKER");
  });
});


it("startPipeline returns doctorWarnings: [] when no doctor issue is cached", async () => {
  const { actorId, ticket } = await seedTicket("Doctor happy path");
  setScript("plan,work,review-pass", true);
  const { runId, doctorWarnings } = await startPipeline(actorId, relayConfig(), {
    ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
  });
  expect(doctorWarnings).toEqual([]);
  await awaitRun(runId);
});

it("startPipeline ignores stale probes for a different binary under the same agent name", async () => {
  const { actorId, ticket } = await seedTicket("Doctor stale probe");
  const config = relayConfig();
  // Cache failures under the same agent NAME but different binaries. The
  // cache is keyed by name+binary, so neither may warn about or block the
  // healthy agent as currently configured (live poisoning incident).
  const badConfig = { workdir: config.workdir, agents: { fake: { ...config.agents.fake, cmd: [join(__dirname, "fixtures", "doctor-exit1.cmd")] } } };
  await runDoctor(badConfig, { fresh: true });
  const missingPath = join(mkdtempSync(join(tmpdir(), "doctor-runs-missing-")), "gone-binary");
  const brokenConfig = { workdir: config.workdir, agents: { fake: { ...config.agents.fake, cmd: [missingPath] } } };
  await runDoctor(brokenConfig, { fresh: true });

  setScript("plan,work,review-pass", true);
  const { runId, doctorWarnings } = await startPipeline(actorId, config, {
    ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
  });
  expect(doctorWarnings).toEqual([]);
  await awaitRun(runId);
});

it("startPipeline throws (400 upstream) when the configured binary's probe is a spawn-level failure", async () => {
  const { actorId, ticket } = await seedTicket("Doctor hard failure");
  const config = relayConfig();
  const missingPath = join(mkdtempSync(join(tmpdir(), "doctor-runs-missing-")), "gone-binary");
  const brokenConfig = { workdir: config.workdir, agents: { fake: { ...config.agents.fake, cmd: [missingPath] } } };
  await runDoctor(brokenConfig, { fresh: true });

  await expect(startPipeline(actorId, brokenConfig, {
    ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
  })).rejects.toThrow(/cannot be spawned/);
});

it("hasActiveRun is true mid-run and false after settle", async () => {
  const { actorId, ticket } = await seedTicket("Active run check");
  setScript("plan,slow");

  const { runId } = await startPipeline(actorId, relayConfig(), {
    ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
  });
  // Assert immediately after start: FAKE_SCRIPT is process-global env, so a
  // parallel test file can overwrite "slow" between spawns and settle this
  // run before a stage-wait completes.
  expect(await hasActiveRun(ticket.id)).toBe(true);

  await waitForStage(runId, "plan");
  stopRun(runId);
  await awaitRun(runId);
  expect(await hasActiveRun(ticket.id)).toBe(false);
}, 15_000);

describe("model verification", () => {
  it("warns when the agent reports a different model than requested", async () => {
    const { actorId, ticket } = await seedTicket("Mismatch path");
    setScript("plan-mismatch,work,review-pass", true);

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", planModel: "fast", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const output = getRunOutput(runId, 0);
    expect(output?.chunk).toContain("WARNING: Model routing mismatch");

    const runs = await listRunsWithHistory();
    const run = runs.find((r) => r.id === runId);
    expect(run?.modelVerified).toBe(false);
  });

  it("marks as verified when the agent reports the requested model", async () => {
    const { actorId, ticket } = await seedTicket("Match path");
    setScript("plan-match,work,review-pass", true);

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", planModel: "fast", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const output = getRunOutput(runId, 0);
    expect(output?.chunk).not.toContain("WARNING: Model routing mismatch");

    const runs = await listRunsWithHistory();
    const run = runs.find((r) => r.id === runId);
    expect(run?.modelVerified).toBe(true);
  });
});


it("verification badge ignores marker strings typed into ordinary comments", async () => {
  const { actorId, ticket } = await seedTicket("Spoof path");
  setScript("plan,work,review-pass", true);

  const { runId } = await startPipeline(actorId, relayConfig(), {
    ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
  });
  await awaitRun(runId);

  // Member-authored plain comment carrying the marker must not flip the badge.
  const { actor: member } = await createActor({ name: uniq("spoofer"), kind: "agent" });
  await addComment(member.id, ticket.id, "[forge: verification=mismatch]", "comment");
  // Member-authored review-kind comment must not either (kind alone is not trust).
  await addComment(member.id, ticket.id, "[forge: verification=mismatch]", "review");

  const runs = await listRunsWithHistory();
  const run = runs.find((r) => r.id === runId);
  expect(run?.modelVerified).not.toBe(false);
});
