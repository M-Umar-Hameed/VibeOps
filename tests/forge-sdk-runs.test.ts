import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { and, eq } from "drizzle-orm";
import { startPipeline, stopRun, awaitRun, getRunOutput } from "../src/forge/runs.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { createTicket } from "../src/services/tickets.js";
import { db } from "../src/db/client.js";
import { aiUsageLogs } from "../src/db/schema.js";
import type { RelayConfig } from "../src/relay/config.js";

process.env.EMBED_PROVIDER = "fake";

// Controllable stub of the SDK. Hoisted so the vi.mock factory can close over it.
const sdkState = vi.hoisted(() => ({
  mode: "success" as "success" | "hang",
  aborted: false,
  started: false,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: any) => {
    sdkState.started = true;
    const signal = args?.options?.abortController?.signal;
    signal?.addEventListener("abort", () => { sdkState.aborted = true; });
    return {
      async *[Symbol.asyncIterator]() {
        if (sdkState.mode === "hang") {
          await new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener("abort", () => resolve());
          });
          return;
        }
        yield { type: "assistant", message: { content: [{ type: "text", text: "REPORT: did the work" }] } };
        yield {
          type: "result", subtype: "success", is_error: false,
          usage: { input_tokens: 900, output_tokens: 100 }, total_cost_usd: 0.0123,
        };
      },
    };
  },
}));

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(__dirname, "fixtures", "fake-agent.mjs");

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-sdk-base-"));
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
  const { actor } = await createActor({ name: uniq("sdk-actor"), kind: "human", role: "admin" });
  const project = await createProject({ key: uniq("sdk-proj"), name: "Forge" });
  const ticket = await createTicket(actor.id, { projectId: project.id, title });
  return { actorId: actor.id, ticket };
}

let workdir: string;
let sandboxRoot: string;
let counterDir: string;
let counterFile: string;

beforeEach(() => {
  workdir = initRepo();
  sandboxRoot = mkdtempSync(join(tmpdir(), "forge-sdk-sbx-"));
  process.env.VIBEOPS_SANDBOX_ROOT = sandboxRoot;
  counterDir = mkdtempSync(join(tmpdir(), "forge-sdk-ctr-"));
  counterFile = join(counterDir, "counter.txt");
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
  sdkState.mode = "success";
  sdkState.aborted = false;
  sdkState.started = false;
});

afterEach(() => {
  delete process.env.VIBEOPS_SANDBOX_ROOT;
  delete process.env.FAKE_SCRIPT;
  delete process.env.FAKE_COUNTER_FILE;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
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
      sdkw: { type: "sdk", roles: ["work"], cmd: [] },
    },
  };
}

function setScript(script: string): void {
  process.env.FAKE_SCRIPT = script;
  process.env.FAKE_COUNTER_FILE = counterFile;
}

async function waitForStage(runId: string, stage: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (getRunOutput(runId, 0)?.stage === stage) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for stage "${stage}"`);
}

describe("forge SDK lane (integration through runs.ts)", () => {
  it("persists real SDK tokens and cost for the work stage (no live call)", async () => {
    const { actorId, ticket } = await seedTicket("SDK telemetry path");
    setScript("plan,review-pass"); // fake-agent runs plan then review; work is sdk

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "sdkw", reviewAgent: "fake",
    });
    await awaitRun(runId);

    expect(getRunOutput(runId, 0)?.status).toBe("passed");

    const [row] = await db.select().from(aiUsageLogs)
      .where(and(eq(aiUsageLogs.ticketId, ticket.id), eq(aiUsageLogs.model, "work")));
    expect(row).toBeTruthy();
    expect(row.provider).toBe("sdkw");
    expect(row.tokens).toBe(1000);   // 900 + 100 real usage, not outputChars/4 estimate
    expect(row.cost).toBe(12300);    // round(0.0123 * 1e6)
  });

  it("stopRun aborts the in-loop sdk work stage via its AbortController", async () => {
    const { actorId, ticket } = await seedTicket("SDK stop path");
    sdkState.mode = "hang";
    setScript("plan"); // only plan invokes fake-agent; work hangs until aborted

    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "sdkw", reviewAgent: "fake",
    });

    await waitForStage(runId, "work");
    // query() is invoked only after runAgentSdk wires onAbort -> run.abort, so
    // started === true guarantees stopRun will find an abort handle.
    while (!sdkState.started) await new Promise((r) => setTimeout(r, 10));

    expect(await stopRun(runId)).toBe(true);
    await awaitRun(runId);

    expect(sdkState.aborted).toBe(true);           // abort path fired (not killTree; sdk has no child)
    expect(getRunOutput(runId, 0)?.status).toBe("stopped");
  }, 15_000);
});
