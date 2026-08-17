import { runDoctor, type ProbeStatus } from "../src/relay/doctor.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, readFileSync } from "node:fs";
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
  getRunTimings,
  hasActiveRun,
  markInterruptedRuns,
  resolveWorkdir,
  awaitRun,
  latestRunPolicy,
  resolveMaxActive
} from "../src/forge/runs.js";
import { sandboxExists, branchName, promoteSandbox, sandboxDiff, hasCommitsToPromote } from "../src/forge/sandbox.js";
import { app } from "../src/api/app.js";
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

function parseSseFrames(buf: string): { event?: string; data?: unknown }[] {
  const out: { event?: string; data?: unknown }[] = [];
  for (const block of buf.split("\n\n")) {
    if (!block.trim() || block.startsWith(":")) continue;
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (!dataLines.length) continue;
    try { out.push({ event, data: JSON.parse(dataLines.join("\n")) }); } catch { /* partial frame */ }
  }
  return out;
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
  delete process.env.FAKE_WRITE_ABS;
  delete process.env.FAKE_WRITE_DEPS;
  delete process.env.FAKE_TOKEN_OUT;
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

// waitForStage flips when the work agent is spawned, which on a loaded runner is
// BEFORE the fixture writes its partial file. Poll the file so a stop can't land
// on a still-clean tree. Bounded; no sleeps.
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

  it("stage stdout is written to the run's logPath and mirrored into run output (S2-A2)", async () => {
    const { actorId, ticket } = await seedTicket("Log file streaming");
    setScript("plan,work,review-pass", true);

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const [row] = await db.select().from(forgeRuns).where(eq(forgeRuns.id, runId));
    expect(row.logPath).toBeTruthy();
    expect(existsSync(row.logPath!)).toBe(true);
    const fileContent = readFileSync(row.logPath!, "utf-8");
    // The log file holds agent stdout; FORGE banners are appended to run.output only.
    expect(fileContent).toContain("do the thing");    // plan agent stdout
    expect(fileContent).toContain("VERDICT: PASS");    // review agent stdout

    // Same bytes reached the in-memory offset API via the tail.
    const chunk = getRunOutput(runId, 0)?.chunk ?? "";
    expect(chunk).toContain("do the thing");
    expect(chunk).toContain("VERDICT: PASS");

    rmSync(row.logPath!, { force: true }); // avoid littering a real ~/.vibeops in the postgres lane
  });

  it("SSE stream carries run.stage before run.settled for a real pipeline run", async () => {
    const { actorId, ticket } = await seedTicket("SSE pipeline");
    const { apiKey } = await createActor({ name: uniq("sse-pipe"), kind: "agent" });
    setScript("plan,work,review-pass", true);

    const res = await app.request("/events", { headers: { Authorization: `Bearer ${apiKey}` } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });

    let buf = "";
    const deadline = Date.now() + 25_000;
    const mine = () =>
      parseSseFrames(buf).filter((f) => {
        const d = f.data as { ticketId?: string; id?: string } | undefined;
        return d?.ticketId === ticket.id || d?.id === ticket.id;
      });
    while (Date.now() < deadline) {
      if (mine().some((f) => f.event === "run.settled")) break;
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
    await reader.cancel();
    await awaitRun(runId);

    const frames = mine();
    const stageIdx = frames.findIndex((f) => f.event === "run.stage");
    const settledIdx = frames.findIndex((f) => f.event === "run.settled");
    expect(stageIdx).toBeGreaterThanOrEqual(0);            // at least one run.stage
    expect(settledIdx).toBeGreaterThan(stageIdx);          // settled comes after a stage, in order
    expect((frames[settledIdx].data as { status?: string }).status).toBe("passed");
    // Build item 3: updateTicket emits ticket.changed on the same bus.
    expect(frames.some((f) => f.event === "ticket.changed")).toBe(true);
  }, 30_000);

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

  it("failing check forces VERDICT: FAIL even when the reviewer passes", async () => {
    const { actorId, ticket } = await seedTicket("Checks force fail");

    // Extend base repo
    const g = (...a: string[]) => execFileSync("git", a, { cwd: workdir });
    writeFileSync(join(workdir, "package.json"), JSON.stringify({ scripts: { typecheck: "node typecheck.js" } }));
    writeFileSync(join(workdir, "typecheck.js"), `console.log("TS-FAKE-9999 boom"); process.exit(1);`);
    g("add", "-A");
    g("commit", "-m", "add check");

    setScript("plan,work,review-pass");

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const output = getRunOutput(runId, 0);
    expect(output?.status).toBe("rejected");
    expect(output?.chunk).toContain("=== FORGE checks ===");
    expect(output?.chunk).toContain("exit 1");

    const comments = await listComments(ticket.id);
    const review = comments.filter((c) => c.kind === "review").pop();
    expect(review?.body).toContain("VERDICT: PASS"); // the model's own verdict, preserved verbatim
    expect(review?.body).toContain("check(s) failed");
    expect(review?.body).toContain("TS-FAKE-9999");
    expect(review?.body).toMatch(/VERDICT:\s*FAIL\s*$/); // forced FAIL wins, at the end

    expect((await getTicket(ticket.id)).status).toBe("planned");
  });

  it("checks run concurrently with review: review starts before the slow check finishes", async () => {
    const { actorId, ticket } = await seedTicket("Concurrent checks");
    await withSetting("forge.checks", JSON.stringify([`node "${join(__dirname, "fixtures", "check-slow.mjs")}"`]), async () => {
      setScript("plan,work,review-pass-slow");
      const { runId } = await startPipeline(actorId, relayConfig(), {
        ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
      });
      await awaitRun(runId);

      // Causality, not wall clock: the review loop must START before the
      // concurrent check FINISHES -- that overlap is what "runs concurrently"
      // means, and it is immune to CPU scheduling drift. Serializing checks
      // before review (await checksPromise first) lands reviewStartedAt after
      // checksEndedAt and fails this.
      const t = getRunTimings(runId);
      expect(t?.checksStartedAt).toBeDefined();
      expect(t?.checksEndedAt).toBeDefined();
      expect(t?.reviewStartedAt).toBeDefined();
      expect(t!.reviewStartedAt!).toBeLessThan(t!.checksEndedAt!);

      const output = getRunOutput(runId, 0);
      expect(output?.status).toBe("passed");
    });
  });

  it("stopping mid-review kills both the review agent and a concurrently running check", async () => {
    const { actorId, ticket } = await seedTicket("Stop mid-review");
    await withSetting("forge.checks", JSON.stringify([`node "${join(__dirname, "fixtures", "check-hang.mjs")}"`]), async () => {
      setScript("plan,work,review-hang");
      const { runId } = await startPipeline(actorId, relayConfig(), {
        ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
      });
      await waitForStage(runId, "review");
      expect(await stopRun(runId)).toBe(true);
      await awaitRun(runId);
      expect(getRunOutput(runId, 0)?.status).toBe("stopped");
    });
  }, 15_000);

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

  it("worker failure with uncommitted work: saves as WIP commit, note in report", async () => {
    const { actorId, ticket } = await seedTicket("Save WIP path");
    setScript("plan,write-then-exit");

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    // Run failed, ticket bounced to planned (unchanged invariant)
    expect(getRunOutput(runId, 0)?.status).toBe("failed");
    expect((await getTicket(ticket.id)).status).toBe("planned");

    // WIP commit was created — hasCommitsToPromote returns true
    expect(await hasCommitsToPromote(workdir, ticket.id)).toBe(true);

    // Report comment contains both "worker failed" and the saved-work note
    const report = [...(await listComments(ticket.id))].reverse().find((c) => c.kind === "report");
    expect(report?.body).toContain("worker failed");
    expect(report?.body).toContain("uncommitted work was saved to the sandbox branch as a WIP commit");
  });

  it("worker failure with NO work written: no WIP commit, no note", async () => {
    const { actorId, ticket } = await seedTicket("No WIP path");
    setScript("plan,exit"); // exits without writing anything

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    expect(getRunOutput(runId, 0)?.status).toBe("failed");
    expect((await getTicket(ticket.id)).status).toBe("planned");

    // No WIP commit — forgeCommit returned false (clean tree)
    expect(await hasCommitsToPromote(workdir, ticket.id)).toBe(false);

    // Report has "worker failed" but NOT the saved-work note
    const report = [...(await listComments(ticket.id))].reverse().find((c) => c.kind === "report");
    expect(report?.body).toContain("worker failed");
    expect(report?.body).not.toContain("uncommitted work was saved");
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
    expect(await stopRun(runId)).toBe(true);
    await awaitRun(runId);
    expect(getRunOutput(runId, 0)?.status).toBe("stopped");
    expect((await getTicket(ticket.id)).status).toBe("planned");
    const summary = listRuns().find((r) => r.id === runId);
    expect(summary?.finishedAt).toBeTruthy();
  }, 15_000);

  it("stop preserves uncommitted work as a WIP commit, note in report", async () => {
    const { actorId, ticket } = await seedTicket("Stop saves WIP path");
    setScript("plan,work-hang"); // work stage writes partial.txt then hangs until killed

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });

    await waitForStage(runId, "work");
    await waitForFile(join(sandboxRoot, ticket.id, "partial.txt"));
    expect(await stopRun(runId)).toBe(true);
    await awaitRun(runId);

    expect(getRunOutput(runId, 0)?.status).toBe("stopped");
    expect((await getTicket(ticket.id)).status).toBe("planned");

    // The WIP commit exists — uncommitted work survived the stop.
    expect(await hasCommitsToPromote(workdir, ticket.id)).toBe(true);

    const report = [...(await listComments(ticket.id))].reverse().find((c) => c.kind === "report");
    expect(report?.body).toContain("uncommitted work was saved to the sandbox branch as a WIP commit");
  }, 15_000);

  it("work stage editing a protected path records a durable violation without forcing the verdict", async () => {
    const { actorId, ticket } = await seedTicket("Protected path violation");
    process.env.FAKE_WRITE_PATH = "vitest.config.ts";
    setScript("plan,work,review-pass");

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);
    // settle() persists the run asynchronously (fire-and-forget); wait for the
    // row to land before querying protected-violations.
    await waitForPersistedRun(runId);

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
    expect(await stopRun("no-such-run")).toBe(false);

    const { actorId, ticket } = await seedTicket("Already settled path");
    setScript("plan,exit");
    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    expect(await stopRun(runId)).toBe(false);
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
    await promoteSandbox(resolved, ticket.id, ticket.title);
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

  it("rework: the change request reaches the REVIEW prompt as an authoritative amendment", async () => {
    const { actorId, ticket } = await seedTicket("Rework amendment reaches reviewer");
    await updateTicket(actorId, ticket.id, ticket.version, { status: "planned" });
    await addComment(actorId, ticket.id, "seeded plan", "plan");
    await addComment(actorId, ticket.id, "CHANGE REQUEST:\nAMEND-MARKER add the DEPS-LEAK hint and a test", "comment");

    setScript("echo-prompt");
    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const chunk = getRunOutput(runId, 0)?.chunk ?? "";
    const reviewIdx = chunk.indexOf("=== FORGE review");
    expect(reviewIdx).toBeGreaterThan(-1);
    const reviewPortion = chunk.slice(reviewIdx);
    // The reviewer is told the supervisor's scope is requested, not scope creep.
    expect(reviewPortion).toContain("AUTHORITATIVE PLAN AMENDMENTS");
    expect(reviewPortion).toContain("AMEND-MARKER add the DEPS-LEAK hint and a test");
    expect(reviewPortion).toContain('<UNTRUSTED label="plan-amendments">');
  });

  it("no change request: the REVIEW prompt has no amendments section (unrequested scope still judged against the plan alone)", async () => {
    const { actorId, ticket } = await seedTicket("No amendment no section");
    await updateTicket(actorId, ticket.id, ticket.version, { status: "planned" });
    await addComment(actorId, ticket.id, "seeded plan", "plan");

    setScript("echo-prompt");
    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const chunk = getRunOutput(runId, 0)?.chunk ?? "";
    const reviewIdx = chunk.indexOf("=== FORGE review");
    expect(reviewIdx).toBeGreaterThan(-1);
    expect(chunk.slice(reviewIdx)).not.toContain("AUTHORITATIVE PLAN AMENDMENTS");
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

  it("persists pid, logPath and runToken while a run is live", async () => {
    const { actorId, ticket } = await seedTicket("Identity live");
    setScript("plan,slow"); // work stage sleeps ~2s so the row stays "running"

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    try {
      const start = Date.now();
      let row;
      for (;;) {
        [row] = await db.select().from(forgeRuns).where(eq(forgeRuns.id, runId));
        if (row && row.pid != null) break;
        if (Date.now() - start > 5000) throw new Error("timed out waiting for a persisted pid");
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(typeof row.pid).toBe("number");
      expect(row.logPath).toBeTruthy();
      expect(row.logPath).toContain(runId);           // stable, per-run
      expect(row.runToken).toMatch(/^[0-9a-f-]{36}$/); // a uuid
    } finally {
      await stopRun(runId);
      await awaitRun(runId);
    }
  }, 15000);

  it("clears pid on settle but keeps logPath and runToken", async () => {
    const { actorId, ticket } = await seedTicket("Identity settled");
    setScript("plan,work,review-pass", true);

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const row = await waitForPersistedRun(runId);
    expect(row.pid).toBeNull();                     // settled row never looks live
    expect(row.logPath).toBeTruthy();
    expect(row.runToken).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("hands VIBEOPS_RUN_TOKEN to the spawned child, equal to the persisted runToken", async () => {
    const { actorId, ticket } = await seedTicket("Child token env");
    const tokenOut = join(counterDir, "token.txt");
    process.env.FAKE_TOKEN_OUT = tokenOut;
    setScript("plan,work,review-pass", true);
    try {
      const { runId } = await startPipeline(actorId, relayConfig(), {
        ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
      });
      await awaitRun(runId);

      const row = await waitForPersistedRun(runId);
      const seen = readFileSync(tokenOut, "utf-8");
      // Mutation guard: omit the token from the child env and this file is "" -> fails.
      expect(seen).toBe(row.runToken);
      expect(seen).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      delete process.env.FAKE_TOKEN_OUT;
    }
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
  await stopRun(runId);
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

describe("resolveMaxActive", () => {
  it("parses a valid positive integer", () => { expect(resolveMaxActive("5")).toBe(5); });
  it("defaults on null", () => { expect(resolveMaxActive(null)).toBe(3); });
  it("defaults on empty/malformed", () => { expect(resolveMaxActive("")).toBe(3); expect(resolveMaxActive("abc")).toBe(3); });
  it("defaults on zero and negative", () => { expect(resolveMaxActive("0")).toBe(3); expect(resolveMaxActive("-2")).toBe(3); });
  it("floors a decimal via parseInt", () => { expect(resolveMaxActive("2.9")).toBe(2); });
});

it("exceeding configured cap rejects with ConflictError naming active runs", async () => {
  const { actorId: a1, ticket: t1 } = await seedTicket("Cap test 1");
  const { actorId: a2, ticket: t2 } = await seedTicket("Cap test 2");
  setScript("slow");

  await withSetting("forge.maxActiveRuns", "1", async () => {
    const { runId } = await startPipeline(a1, relayConfig(), {
      ticketId: t1.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    try {
      // First assertion: rejects with ConflictError
      await expect(startPipeline(a2, relayConfig(), {
        ticketId: t2.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
      })).rejects.toThrow(ConflictError);

      // Second assertion: message contains the cap and ticket id
      await expect(startPipeline(a2, relayConfig(), {
        ticketId: t2.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
      })).rejects.toThrow(/concurrency cap reached: 1\/1/);

      await expect(startPipeline(a2, relayConfig(), {
        ticketId: t2.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
      })).rejects.toThrow(new RegExp(t1.id));
    } finally {
      await stopRun(runId);
      await awaitRun(runId);
    }
  });
}, 15_000);

describe("concurrency integration", () => {
  it("two concurrent pipelines produce their own correct diffs with no cross-contamination", async () => {
    const { actorId: a1, ticket: t1 } = await seedTicket("Concurrent A");
    const { actorId: a2, ticket: t2 } = await seedTicket("Concurrent B");

    // Each run gets its own counter file via agent.env to avoid desync when
    // two pipelines consume the script concurrently.
    const counter1 = join(counterDir, "counter1.txt");
    const counter2 = join(counterDir, "counter2.txt");

    // Each run writes a DISTINCT filename so we can assert mutual exclusion.
    const file1 = "run1-output.txt";
const file2 = "run2-output.txt";

    const config1 = (): RelayConfig => ({
      workdir,
      agents: {
        fake: {
          cmd: [process.execPath, FAKE_AGENT, "{prompt}", "--model", "{model}"],
          roles: ["plan", "work", "review"],
          models: [{ name: "fast", tier: "free", quality: 2 }, { name: "smart", tier: "expensive", quality: 5 }],
          env: {
            FAKE_SCRIPT: "plan,work,review-pass",
            FAKE_COUNTER_FILE: counter1,
            FAKE_WRITE_PATH: file1,
          },
        },
      },
    });
    const config2 = (): RelayConfig => ({
      workdir,
      agents: {
        fake: {
          cmd: [process.execPath, FAKE_AGENT, "{prompt}", "--model", "{model}"],
          roles: ["plan", "work", "review"],
          models: [{ name: "fast", tier: "free", quality: 2 }, { name: "smart", tier: "expensive", quality: 5 }],
          env: {
            FAKE_SCRIPT: "plan,work,review-pass",
            FAKE_COUNTER_FILE: counter2,
            FAKE_WRITE_PATH: file2,
          },
        },
      },
    });

    // Start both pipelines and await them CONCURRENTLY via Promise.all
    const r1 = await startPipeline(a1, config1(), {
      ticketId: t1.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    const r2 = await startPipeline(a2, config2(), {
      ticketId: t2.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await Promise.all([awaitRun(r1.runId), awaitRun(r2.runId)]);

    expect(getRunOutput(r1.runId, 0)?.status).toBe("passed");
    expect(getRunOutput(r2.runId, 0)?.status).toBe("passed");

    const diff1 = await sandboxDiff(workdir, t1.id);
    const diff2 = await sandboxDiff(workdir, t2.id);
    // Each diff contains only ITS OWN file
    expect(diff1).toContain(file1);
    expect(diff2).toContain(file2);
    // Cross-contamination assertions: each diff EXCLUDES the other's filename
    expect(diff1).not.toContain(file2);
    expect(diff2).not.toContain(file1);
    // Both sandboxes exist independently
    expect(sandboxExists(t1.id)).toBe(true);
    expect(sandboxExists(t2.id)).toBe(true);
  });

  it("deps leak through shared node_modules fails the run and reverts the base", async () => {
    // Create node_modules in the base workdir so linkDeps will link it
    mkdirSync(join(workdir, "node_modules"), { recursive: true });
    writeFileSync(join(workdir, "node_modules", "marker.txt"), "base\n");

    const { actorId, ticket } = await seedTicket("Deps leak test");
    setScript("plan,work,review-pass");
    process.env.FAKE_WRITE_DEPS = "LEAK.txt";

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const output = getRunOutput(runId, 0);
    expect(output?.status).toBe("failed");
    expect(output?.chunk).toContain("DEPS-LEAK");
    // The leaked file should have been reverted from the base
    expect(existsSync(join(workdir, "node_modules", "LEAK.txt"))).toBe(false);
  });

  it("deps leak in app/node_modules without frontendDeps prints the setting hint", async () => {
    mkdirSync(join(workdir, "app", "node_modules"), { recursive: true });
    writeFileSync(join(workdir, "app", "node_modules", "marker.txt"), "base\n");

    const { actorId, ticket } = await seedTicket("Deps leak test app deps");
    setScript("plan,work,review-pass");
    process.env.FAKE_WRITE_DEPS = "../app/node_modules/LEAK.txt";

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const output = getRunOutput(runId, 0);
    expect(output?.status).toBe("failed");
    expect(output?.chunk).toContain("DEPS-LEAK");
    expect(output?.chunk).toContain("Hint: a frontend build needs forge.frontendDeps set to true");
  });

  it("deps leak in app/node_modules WITH frontendDeps omits the setting hint", async () => {
    mkdirSync(join(workdir, "app", "node_modules"), { recursive: true });
    writeFileSync(join(workdir, "app", "node_modules", "marker.txt"), "base\n");

    const { actorId, ticket } = await seedTicket("Deps leak test app deps enabled");
    setScript("plan,work,review-pass");
    process.env.FAKE_WRITE_ABS = join(workdir, "app", "node_modules", "LEAK.txt");

    await withSetting("forge.frontendDeps", "true", async () => {
      const { runId } = await startPipeline(actorId, relayConfig(), {
        ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
      });
      await awaitRun(runId);

      const output = getRunOutput(runId, 0);
      expect(output?.status).toBe("failed");
      expect(output?.chunk).toContain("DEPS-LEAK");
      expect(output?.chunk).not.toContain("Hint: a frontend build needs forge.frontendDeps set to true");
    });
  });

  it("deps leak in ROOT node_modules without frontendDeps does NOT print the hint", async () => {
    // ROOT leak with frontendDeps unset
    mkdirSync(join(workdir, "node_modules"), { recursive: true });
    writeFileSync(join(workdir, "node_modules", "marker.txt"), "base\n");

    const { actorId, ticket } = await seedTicket("Deps leak test root");
    setScript("plan,work,review-pass");
    process.env.FAKE_WRITE_DEPS = "LEAK2.txt";

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const output = getRunOutput(runId, 0);
    expect(output?.status).toBe("failed");
    expect(output?.chunk).toContain("DEPS-LEAK");
    expect(output?.chunk).not.toContain("Hint: a frontend build needs forge.frontendDeps set to true");
  });

  it("sandbox escape WIP-commits the sandbox edits before failing", async () => {
    const { actorId, ticket } = await seedTicket("Escape WIP commit");
    const sensitive = join(counterDir, "server.mjs");
    writeFileSync(sensitive, "GOOD\n");
    setScript("plan,work,review-pass", true); // FAKE_WRITE=1 -> forge-made.txt in sandbox
    process.env.FAKE_WRITE_ABS = sensitive;     // escape -> sentinel fires

    await withSetting("forge.sensitivePaths", JSON.stringify([sensitive]), async () => {
      const { runId } = await startPipeline(actorId, relayConfig(), {
        ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
      });
      await awaitRun(runId);
      const output = getRunOutput(runId, 0);
      expect(output?.status).toBe("failed");
      expect(output?.chunk).toContain("SANDBOX-ESCAPE");
      // the escaped write was reverted
      expect(readFileSync(sensitive, "utf-8")).toBe("GOOD\n");
    });
    // the work-stage edits survive as a commit on the sandbox branch
    expect(await hasCommitsToPromote(workdir, ticket.id)).toBe(true);
  }, 20_000);

  it("deps leak WIP-commits the sandbox edits before failing", async () => {
    mkdirSync(join(workdir, "node_modules"), { recursive: true });
    writeFileSync(join(workdir, "node_modules", "marker.txt"), "base\n");

    const { actorId, ticket } = await seedTicket("Deps leak WIP commit");
    setScript("plan,work,review-pass", true); // FAKE_WRITE=1 -> forge-made.txt in sandbox
    process.env.FAKE_WRITE_DEPS = "LEAK.txt";  // leak -> sentinel fires

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);
    const output = getRunOutput(runId, 0);
    expect(output?.status).toBe("failed");
    expect(output?.chunk).toContain("DEPS-LEAK");
    expect(existsSync(join(workdir, "node_modules", "LEAK.txt"))).toBe(false); // reverted
    // the work-stage edits survive as a commit on the sandbox branch
    expect(await hasCommitsToPromote(workdir, ticket.id)).toBe(true);
  }, 20_000);

  it("promote conflict end-to-end: second promote fails, names file, sandbox intact", async () => {
    const { actorId: a1, ticket: t1 } = await seedTicket("Promote conflict 1");
    const { actorId: a2, ticket: t2 } = await seedTicket("Promote conflict 2");

    // Both edit the same file but with different content to cause a real conflict.
    // FAKE_WRITE_PATH writes generic content, so we manually diverge them post-run.
    setScript("plan,work,review-pass");
    const r1 = await startPipeline(a1, relayConfig(), {
      ticketId: t1.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(r1.runId);

    // Reset counter for the second run
    if (existsSync(counterFile)) rmSync(counterFile);
    setScript("plan,work,review-pass");
    const r2 = await startPipeline(a2, relayConfig(), {
      ticketId: t2.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(r2.runId);

    expect(getRunOutput(r1.runId, 0)?.status).toBe("passed");
    expect(getRunOutput(r2.runId, 0)?.status).toBe("passed");

    // Both sandboxes have forge-made.txt with same content. Create a conflict by
    // making them edit the same LINE of the same file with different content.
    const sandbox1 = join(sandboxRoot, t1.id);
    const sandbox2 = join(sandboxRoot, t2.id);
    const g1 = (...a: string[]) => execFileSync("git", a, { cwd: sandbox1, encoding: "utf-8" });
    const g2 = (...a: string[]) => execFileSync("git", a, { cwd: sandbox2, encoding: "utf-8" });

    writeFileSync(join(sandbox1, "readme.md"), "version A\n");
    g1("add", "-A");
    g1("commit", "-m", "conflict A");

    writeFileSync(join(sandbox2, "readme.md"), "version B\n");
    g2("add", "-A");
    g2("commit", "-m", "conflict B");

    // First promote succeeds
    await promoteSandbox(workdir, t1.id, t1.title);
    expect(sandboxExists(t1.id)).toBe(false);

    // Second promote conflicts
    let err: any;
    try { await promoteSandbox(workdir, t2.id, t2.title); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toContain("readme.md");
    expect(err.message).toContain("conflicts with the base");
    // Second sandbox is still intact
    expect(sandboxExists(t2.id)).toBe(true);
  });

  it("gate BLOCK forces VERDICT: FAIL even when the model says PASS", async () => {
    const { actorId, ticket } = await seedTicket("Gate block forces fail");
    // Write a stray file not in plan (triggers file-set block)
    process.env.FAKE_WRITE_PATH = "target.txt";
    setScript("plan,work,review-pass");

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const output = getRunOutput(runId, 0);
    // Run settles rejected despite the model's PASS
    expect(output?.status).toBe("rejected");
    expect(output?.chunk).toContain("=== FORGE gate ===");
    expect(output?.chunk).toContain("AUTOMATIC BLOCK");
    expect(output?.chunk).toContain("target.txt");

    // The review comment ends with VERDICT: FAIL (forced by gate)
    const comments = await listComments(ticket.id);
    const review = comments.filter((c) => c.kind === "review").pop();
    expect(review?.body).toContain("[forge: mechanical gate BLOCK");
    expect(review?.body).toMatch(/VERDICT:\s*FAIL\s*$/);

    // Ticket bounced to planned
    expect((await getTicket(ticket.id)).status).toBe("planned");
  });

  it("gate clean: model PASS is respected, ticket stays in review", async () => {
    const { actorId, ticket } = await seedTicket("Gate clean path");
    // No stray files - plan mentions the same file the agent writes
    await updateTicket(actorId, ticket.id, ticket.version, { body: "Write forge-made.txt" });
    process.env.FAKE_WRITE_PATH = "forge-made.txt";
    setScript("plan,work,review-pass");

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const output = getRunOutput(runId, 0);
    expect(output?.status).toBe("passed");

    // No AUTOMATIC BLOCK in output
    expect(output?.chunk).not.toContain("AUTOMATIC BLOCK");

    // Review comment contains PASS without forced FAIL
    const comments = await listComments(ticket.id);
    const review = comments.filter((c) => c.kind === "review").pop();
    expect(review?.body).not.toContain("[forge: mechanical gate BLOCK");
    expect(review?.body).toContain("VERDICT: PASS");

    // Ticket stays in review awaiting promote
    expect((await getTicket(ticket.id)).status).toBe("review");
  });

  it("rejected run exposes a one-sentence rejectionReason in the runs API", async () => {
    const { actorId, ticket } = await seedTicket("Rejection reason surfaces");
    setScript("plan,work,review-fail-reason", true);

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const runs = await listRunsWithHistory();
    const item = runs.find((r) => r.id === runId);
    expect(item?.status).toBe("rejected");
    expect(item?.rejectionReason).toBe("The widget crashes on empty input.");
  });

  it("settled run exposes per-stage duration breakdown in the runs API", async () => {
    const { actorId, ticket } = await seedTicket("Stage durations");
    setScript("plan,work,review-pass", true);

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const runs = await listRunsWithHistory();
    const item = runs.find((r) => r.id === runId);
    expect(item?.status).toBe("passed");
    expect(item?.stageDurationsMs?.plan).toBeGreaterThan(0);
    expect(item?.stageDurationsMs?.work).toBeGreaterThan(0);
    expect(item?.stageDurationsMs?.review).toBeGreaterThan(0);
    expect(item?.stageDurationsMs?.checks).toBeUndefined();
  });

  it("checks duration is recorded on the run and surfaced in stageDurationsMs", async () => {
    const { actorId, ticket } = await seedTicket("Checks duration recorded");
    const g = (...a: string[]) => execFileSync("git", a, { cwd: workdir });
    writeFileSync(join(workdir, "package.json"), JSON.stringify({ scripts: { typecheck: "node typecheck.js" } }));
    writeFileSync(join(workdir, "typecheck.js"), `console.log("ok"); process.exit(0);`);
    g("add", "-A");
    g("commit", "-m", "add check");

    setScript("plan,work,review-pass", true);
    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const runs = await listRunsWithHistory();
    const item = runs.find((r) => r.id === runId);
    expect(item?.status).toBe("passed");
    expect(item?.checksDurationMs).toBeGreaterThanOrEqual(0);
    expect(item?.stageDurationsMs?.checks).toBeGreaterThanOrEqual(0);
  });
});

// The SSE transport test drives emitEvent directly, so removing the emit from a
// real stage transition was invisible to it (the mutation survived). Pin the
// wiring itself: a live pipeline must publish run.stage and run.settled on the
// bus. Note the bus uses ONE channel ("event") carrying { type, payload }.
describe("forge emits run lifecycle events", () => {
  it("a pipeline publishes run.stage and run.settled on the event bus", async () => {
    const { events } = await import("../src/api/events.js");
    const seen: { type: string; runId?: string }[] = [];
    const onEvent = (e: any) => seen.push({ type: e?.type, runId: e?.payload?.runId });
    events.on("event", onEvent);
    try {
      const { actorId, ticket } = await seedTicket("Emits lifecycle events");
      setScript("plan,work,review-pass", true);
      const { runId } = await startPipeline(actorId, relayConfig(), {
        ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
      });
      await awaitRun(runId);
      expect(seen.some((e) => e.type === "run.stage" && e.runId === runId)).toBe(true);
      expect(seen.some((e) => e.type === "run.settled" && e.runId === runId)).toBe(true);
    } finally {
      events.off("event", onEvent);
    }
  }, 30_000);
});
