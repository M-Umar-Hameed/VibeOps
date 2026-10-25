import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { db } from "../src/db/client.js";
import { forgeRuns } from "../src/db/schema.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { createTicket } from "../src/services/tickets.js";
import { app } from "../src/api/app.js";
import { settleAll } from "../src/forge/runs.js";
import { vibeopsHome } from "../src/runtime/home.js";

process.env.EMBED_PROVIDER = "fake";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(__dirname, "fixtures", "fake-agent.mjs");

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-out-base-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  g("init", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "readme.md"), "base\n");
  g("add", "-A");
  g("commit", "-m", "base");
  return dir;
}

async function adminHeaders(): Promise<Record<string, string>> {
  const { apiKey } = await createActor({ name: uniq("forge-out-admin"), kind: "human", role: "admin" });
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function seedTicket() {
  const { actor } = await createActor({ name: uniq("forge-out-actor"), kind: "human" });
  const project = await createProject({ key: uniq("forge-out-proj"), name: "Forge Out" });
  return createTicket(actor.id, { projectId: project.id, title: "Forge Out ticket" });
}

function writeRelayConfig(relayConfigPath: string, workdir: string): void {
  writeFileSync(relayConfigPath, JSON.stringify({
    workdir,
    agents: { fake: { cmd: [process.execPath, FAKE_AGENT, "{prompt}"], roles: ["plan", "work", "review"] } },
  }));
}

let workdir: string;
let sandboxRoot: string;
let relayConfigPath: string;
let runsDir: string;
let logFiles: string[];

function mkRow(ticketId: string, logPath: string | null) {
  return {
    id: randomUUID(),
    ticketId,
    status: "failed" as const,
    stage: "work" as const,
    planAgent: "fake",
    workAgent: "fake",
    reviewAgent: "fake",
    logPath,
    startedAt: new Date(),
    finishedAt: new Date(),
  };
}

beforeEach(() => {
  workdir = initRepo();
  sandboxRoot = mkdtempSync(join(tmpdir(), "forge-out-sbx-"));
  relayConfigPath = join(mkdtempSync(join(tmpdir(), "forge-out-cfg-")), "relay.json");
  runsDir = join(vibeopsHome(), ".vibeops", "runs");
  mkdirSync(runsDir, { recursive: true });
  logFiles = [];
  process.env.VIBEOPS_SANDBOX_ROOT = sandboxRoot;
  process.env.VIBEOPS_RELAY_CONFIG = relayConfigPath;
  writeRelayConfig(relayConfigPath, workdir);
});

afterEach(async () => {
  await settleAll();
  delete process.env.VIBEOPS_SANDBOX_ROOT;
  delete process.env.VIBEOPS_RELAY_CONFIG;
  const wts = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: workdir, encoding: "utf8" });
  for (const line of wts.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const wt = line.slice(9).trim();
    if (resolve(wt) === resolve(workdir)) continue;
    execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: workdir });
  }
  rmSync(sandboxRoot, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
  rmSync(dirname(relayConfigPath), { recursive: true, force: true });
  for (const f of logFiles) rmSync(f, { force: true });
});

describe("forge run output", () => {
  it("settled run from log", async () => {
    const h = await adminHeaders();
    const { ticketId } = await seedTicket();
    const row = mkRow(ticketId, null);
    const logPath = join(runsDir, `${row.id}.log`);
    row.logPath = logPath;
    logFiles.push(logPath);
    writeFileSync(logPath, "hello sk-abcdefghij0123456789 bye\n");
    await db.insert(forgeRuns).values(row);

    const res = await app.request(`/forge/runs/${row.id}/output?after=0`, { method: "GET", headers: h });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("log");
    expect(body.status).toBe("failed");
    expect(body.stage).toBe("work");
    expect(body.chunk).toContain("[redacted]");
    expect(body.chunk).not.toContain("sk-abcdefghij0123456789");
    expect(body.next).toBe(body.chunk.length);

    const fileContent = readFileSync(logPath, "utf-8");
    expect(fileContent).toContain("sk-abcdefghij0123456789");

    const res2 = await app.request(`/forge/runs/${row.id}/output?after=${body.next}`, { method: "GET", headers: h });
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.chunk).toBe("");
  }, 30000);

  it("path outside the runs dir", async () => {
    const h = await adminHeaders();
    const { ticketId } = await seedTicket();
    const outsideDir = mkdtempSync(join(tmpdir(), "forge-out-outside-"));
    const logPath = join(outsideDir, `${randomUUID()}.log`);
    writeFileSync(logPath, "outside\n");
    const row = mkRow(ticketId, logPath);
    await db.insert(forgeRuns).values(row);

    const res = await app.request(`/forge/runs/${row.id}/output?after=0`, { method: "GET", headers: h });
    expect(res.status).toBe(404);

    rmSync(outsideDir, { recursive: true, force: true });
  }, 30000);

  it("missing file", async () => {
    const h = await adminHeaders();
    const { ticketId } = await seedTicket();
    const logPath = join(runsDir, `${randomUUID()}.log`);
    const row = mkRow(ticketId, logPath);
    await db.insert(forgeRuns).values(row);

    const res = await app.request(`/forge/runs/${row.id}/output?after=0`, { method: "GET", headers: h });
    expect(res.status).toBe(404);
  }, 30000);

  it("live run", async () => {
    const h = await adminHeaders();
    const { ticketId } = await seedTicket();
    process.env.FAKE_SCRIPT = "exit 0";

    const startRes = await app.request("/forge/pipeline", {
      method: "POST", headers: h,
      body: JSON.stringify({ ticketId, planAgent: "fake", workAgent: "fake", reviewAgent: "fake" }),
    });
    const { runId } = await startRes.json();

    let final;
    for (let i = 0; i < 100; i++) {
      await new Promise(r => setTimeout(r, 100));
      const pollRes = await app.request(`/forge/runs/${runId}`, { method: "GET", headers: h });
      const poll = await pollRes.json();
      if (poll.status !== "running") {
        final = poll;
        break;
      }
    }
    expect(final).toBeDefined();
    expect(final.status).toBe("passed");

    const outRes = await app.request(`/forge/runs/${runId}/output?after=0`, { method: "GET", headers: h });
    expect(outRes.status).toBe(200);
    const body = await outRes.json();
    expect(body.source).toBeUndefined();
    expect(body.status).toBe("passed");

    delete process.env.FAKE_SCRIPT;
  }, 30000);
});
