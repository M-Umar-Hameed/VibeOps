import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import {
  startPipeline, stopRun, awaitRun, getRunOutput,
  sweepStalledRuns, logSizeReader, resolveStallWindowMs,
} from "../src/forge/runs.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { createTicket } from "../src/services/tickets.js";
import { listComments } from "../src/services/comments.js";
import { db } from "../src/db/client.js";
import { forgeRuns } from "../src/db/schema.js";
import type { RelayConfig } from "../src/relay/config.js";

process.env.EMBED_PROVIDER = "fake";
const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(__dirname, "fixtures", "fake-agent.mjs");
const WINDOW = 30 * 60_000;

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-stall-base-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  g("init", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(dir, "readme.md"), "base\n"); g("add", "-A"); g("commit", "-m", "base");
  return dir;
}
function uniq(p: string) { return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
async function seedTicket(title: string) {
  const { actor } = await createActor({ name: uniq("stall-actor"), kind: "human", role: "admin" });
  const project = await createProject({ key: uniq("stall-proj"), name: "Forge" });
  const ticket = await createTicket(actor.id, { projectId: project.id, title });
  return { actorId: actor.id, ticket };
}

let workdir: string, sandboxRoot: string, counterDir: string, counterFile: string;
beforeEach(() => {
  workdir = initRepo();
  sandboxRoot = mkdtempSync(join(tmpdir(), "forge-stall-sbx-"));
  process.env.VIBEOPS_SANDBOX_ROOT = sandboxRoot;
  counterDir = mkdtempSync(join(tmpdir(), "forge-stall-ctr-"));
  counterFile = join(counterDir, "counter.txt");
});
afterEach(() => {
  delete process.env.VIBEOPS_SANDBOX_ROOT;
  delete process.env.FAKE_SCRIPT; delete process.env.FAKE_COUNTER_FILE; delete process.env.FAKE_WRITE;
  rmSync(workdir, { recursive: true, force: true });
  rmSync(sandboxRoot, { recursive: true, force: true });
  rmSync(counterDir, { recursive: true, force: true });
});

function relayConfig(): RelayConfig {
  return { workdir, agents: { fake: {
    cmd: [process.execPath, FAKE_AGENT, "{prompt}", "--model", "{model}"],
    roles: ["plan", "work", "review"],
    models: [{ name: "fast", tier: "free", quality: 2 }, { name: "smart", tier: "expensive", quality: 5 }],
  } } };
}
function setScript(script: string, write?: boolean) {
  process.env.FAKE_SCRIPT = script; process.env.FAKE_COUNTER_FILE = counterFile;
  if (write) process.env.FAKE_WRITE = "1"; else delete process.env.FAKE_WRITE;
}
async function waitForStage(runId: string, stage: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (getRunOutput(runId, 0)?.stage === stage) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for stage "${stage}"`);
}
async function waitForPid(runId: string, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    const [row] = await db.select().from(forgeRuns).where(eq(forgeRuns.id, runId));
    if (row?.stage === "work" && row?.pid != null) return;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for pid");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("forge stall detection", () => {
  it("settles failed with a stall reason when the log stops growing past the window", async () => {
    const { actorId, ticket } = await seedTicket("stall detect");
    setScript("plan,work-hang");
    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await waitForStage(runId, "work");
    await waitForPid(runId); // run.child now set -> sweep's killTree(child) branch fires

    const orig = logSizeReader.read;
    logSizeReader.read = () => 100; // constant: never grows
    try {
      const t0 = 1_700_000_000_000;
      expect(await sweepStalledRuns(t0, WINDOW)).toEqual([]);            // first sight: seed only
      expect(getRunOutput(runId, 0)?.status).toBe("running");
      expect(await sweepStalledRuns(t0 + WINDOW + 60_000, WINDOW)).toEqual([runId]); // 31m silent
    } finally { logSizeReader.read = orig; }

    await awaitRun(runId);
    expect(getRunOutput(runId, 0)?.status).toBe("failed");
    const report = [...(await listComments(ticket.id))].reverse()
      .find((c) => c.kind === "report" && c.body.includes("stalled: no output"));
    expect(report).toBeTruthy();
    expect(report!.body).toContain("work stage");
  }, 20_000);

  it("does NOT kill a run whose log is still growing, even far past the window", async () => {
    const { actorId, ticket } = await seedTicket("still growing");
    setScript("plan,work-hang");
    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await waitForStage(runId, "work");
    await waitForPid(runId);

    const orig = logSizeReader.read;
    let n = 100;
    logSizeReader.read = () => (n += 50); // grows on every read
    try {
      const t0 = 1_700_000_000_000;
      await sweepStalledRuns(t0, WINDOW);
      await sweepStalledRuns(t0 + WINDOW * 10, WINDOW);                  // far past window, but grew
      expect(getRunOutput(runId, 0)?.status).toBe("running");
      expect(await sweepStalledRuns(t0 + WINDOW * 11, WINDOW)).toEqual([]);
    } finally { logSizeReader.read = orig; }

    expect(await stopRun(runId)).toBe(true); // clean up the hung child
    await awaitRun(runId);
  }, 20_000);

  it("leaves a run that legitimately completes quickly untouched", async () => {
    const { actorId, ticket } = await seedTicket("fast run");
    setScript("plan,work,review-pass", true);
    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);
    expect(getRunOutput(runId, 0)?.status).toBe("passed");
    // Settled -> not active -> sweep is a no-op no matter how far the clock is pushed.
    expect(await sweepStalledRuns(Date.now() + 10 * 60 * 60_000, WINDOW)).toEqual([]);
  }, 20_000);

  it("resolveStallWindowMs falls back to 30m on unset/garbage", () => {
    expect(resolveStallWindowMs(null)).toBe(30 * 60_000);
    expect(resolveStallWindowMs("0")).toBe(30 * 60_000);
    expect(resolveStallWindowMs("abc")).toBe(30 * 60_000);
    expect(resolveStallWindowMs("60000")).toBe(60_000);
  });
});
