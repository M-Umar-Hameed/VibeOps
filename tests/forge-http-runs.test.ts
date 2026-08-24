import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { startPipeline, awaitRun, getRunOutput } from "../src/forge/runs.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { createTicket } from "../src/services/tickets.js";
import { listComments } from "../src/services/comments.js";
import { withSetting } from "./helpers/settings.js";
import type { RelayConfig } from "../src/relay/config.js";

process.env.EMBED_PROVIDER = "fake";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(__dirname, "fixtures", "fake-agent.mjs");

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-http-base-"));
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
  const { actor } = await createActor({ name: uniq("http-actor"), kind: "human", role: "admin" });
  const project = await createProject({ key: uniq("http-proj"), name: "Forge" });
  const ticket = await createTicket(actor.id, { projectId: project.id, title });
  return { actorId: actor.id, ticket };
}

let workdir: string;
let sandboxRoot: string;
let counterDir: string;
let counterFile: string;
let server: Server;
let port: number;
let handler: (req: any, res: any, body: string) => void = () => {};
let requestCount = 0;
let seenBody: any = null;

beforeEach(async () => {
  requestCount = 0;
  seenBody = null;
  handler = () => {};
  server = createServer((req, res) => {
    requestCount++;
    let body = "";
    req.on("data", (c: Buffer) => (body += c));
    req.on("end", () => { seenBody = body; handler(req, res, body); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;

  delete process.env.FAKE_SCRIPT;
  delete process.env.FAKE_COUNTER_FILE;
  workdir = initRepo();
  sandboxRoot = mkdtempSync(join(tmpdir(), "forge-http-sbx-"));
  process.env.VIBEOPS_SANDBOX_ROOT = sandboxRoot;
  counterDir = mkdtempSync(join(tmpdir(), "forge-http-ctr-"));
  counterFile = join(counterDir, "counter.txt");
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  delete process.env.VIBEOPS_SANDBOX_ROOT;
  rmSync(workdir, { recursive: true, force: true });
  rmSync(sandboxRoot, { recursive: true, force: true });
  rmSync(counterDir, { recursive: true, force: true });
});

function json(res: any, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
  res.end(JSON.stringify(body));
}

// fakeRoles carries whichever of plan/work/review is NOT the http lane;
// FAKE_SCRIPT must list a step per fake invocation, in order.
function relayConfig(fakeRoles: string[], fakeScript: string, httpRole: string): RelayConfig {
  return {
    workdir,
    agents: {
      fake: {
        cmd: [process.execPath, FAKE_AGENT, "{prompt}"],
        roles: fakeRoles,
        env: { FAKE_SCRIPT: fakeScript, FAKE_COUNTER_FILE: counterFile },
      },
      openrouter: {
        cmd: [], type: "http", baseUrl: `http://127.0.0.1:${port}/v1`, keySetting: "orRunsTestKey",
        roles: [httpRole], models: [{ name: "m", tier: "cheap", quality: 3 }],
      },
    },
  };
}

describe("forge http lane (integration through runs.ts)", () => {
  it("plan stage on an http lane posts the plan comment from the mock's reply", async () => {
    handler = (_req, res) => json(res, 200, { choices: [{ message: { content: "1. do the thing via openrouter" } }] });
    const { actorId, ticket } = await seedTicket("HTTP plan lane");

    await withSetting("orRunsTestKey", "sk-or-test", async () => {
      const { runId } = await startPipeline(actorId, relayConfig(["work", "review"], "work,review-pass", "plan"), {
        ticketId: ticket.id, planAgent: "openrouter", planModel: "m", workAgent: "fake", reviewAgent: "fake",
      });
      await awaitRun(runId);
      expect(getRunOutput(runId, 0)?.status).toBe("passed");
    });

    // Only the plan stage should have hit the mock -- work/review ran on the cli fake lane.
    expect(requestCount).toBe(1);
    const parsedBody = JSON.parse(seenBody);
    expect(parsedBody.model).toBe("m");
    expect(parsedBody.messages).toEqual([{ role: "user", content: expect.stringContaining("HTTP plan lane") }]);

    const comments = await listComments(ticket.id);
    const plan = comments.find((c) => c.kind === "plan");
    expect(plan?.body).toContain("1. do the thing via openrouter");
  });

  it("review stage on an http lane parses VERDICT: PASS from the mock's reply", async () => {
    handler = (_req, res) => json(res, 200, { choices: [{ message: { content: "looks good\nVERDICT: PASS" } }] });
    const { actorId, ticket } = await seedTicket("HTTP review lane pass");

    await withSetting("orRunsTestKey", "sk-or-test", async () => {
      const { runId } = await startPipeline(actorId, relayConfig(["plan", "work"], "plan,work", "review"), {
        ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "openrouter", reviewModel: "m",
      });
      await awaitRun(runId);
      expect(getRunOutput(runId, 0)?.status).toBe("passed");
    });

    expect(requestCount).toBe(1);
    const comments = await listComments(ticket.id);
    const review = comments.find((c) => c.kind === "review");
    expect(review?.body).toContain("VERDICT: PASS");
  });

  it("review stage on an http lane bounces the ticket on a VERDICT: FAIL reply", async () => {
    handler = (_req, res) => json(res, 200, { choices: [{ message: { content: "broken\nVERDICT: FAIL\n- fix it" } }] });
    const { actorId, ticket } = await seedTicket("HTTP review lane fail");

    await withSetting("orRunsTestKey", "sk-or-test", async () => {
      const { runId } = await startPipeline(actorId, relayConfig(["plan", "work"], "plan,work", "review"), {
        ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "openrouter", reviewModel: "m",
      });
      await awaitRun(runId);
      expect(getRunOutput(runId, 0)?.status).toBe("rejected");
    });
  });

  it("a colon-suffixed model id (e.g. an OpenRouter free variant) reaches runHttpAgent unmodified", async () => {
    // modelOf() in runs.ts extracts the model half of the "agent:model" composite
    // string it stores on the run; a model id that itself contains a colon (the
    // OpenRouter ":free" suffix convention) must not be truncated there.
    const httpAgentModule = await import("../src/relay/http-agent.js");
    const spy = vi.spyOn(httpAgentModule, "runHttpAgent").mockResolvedValue({ ok: true, output: "1. do it" });
    const modelId = "meta-llama/llama-3.1-8b-instruct:free";
    try {
      const { actorId, ticket } = await seedTicket("HTTP colon-suffixed model id");
      const config = relayConfig(["work", "review"], "work,review-pass", "plan");
      config.agents.openrouter.models = [{ name: modelId, tier: "free", quality: 3 }];

      const { runId } = await startPipeline(actorId, config, {
        ticketId: ticket.id, planAgent: "openrouter", planModel: modelId, workAgent: "fake", reviewAgent: "fake",
      });
      await awaitRun(runId);

      expect(getRunOutput(runId, 0)?.status).toBe("passed");
      expect(spy).toHaveBeenCalledWith(expect.anything(), expect.any(String), modelId, expect.anything());
    } finally {
      spy.mockRestore();
    }
  });
});
