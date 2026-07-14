import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { createTicket } from "../src/services/tickets.js";
import { app } from "../src/api/app.js";

process.env.EMBED_PROVIDER = "fake";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(__dirname, "fixtures", "fake-agent.mjs");

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-api-base-"));
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
  const { apiKey } = await createActor({ name: uniq("forge-api-admin"), kind: "human", role: "admin" });
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function seedTicket() {
  const { actor } = await createActor({ name: uniq("forge-api-actor"), kind: "human" });
  const project = await createProject({ key: uniq("forge-api-proj"), name: "Forge API" });
  return createTicket(actor.id, { projectId: project.id, title: "Forge API ticket" });
}

let workdir: string;
let sandboxRoot: string;
let relayConfigPath: string;
let counterFile: string;

function writeRelayConfig(): void {
  writeFileSync(relayConfigPath, JSON.stringify({
    workdir,
    agents: { fake: { cmd: [process.execPath, FAKE_AGENT, "{prompt}"], roles: ["plan", "work", "review"] } },
  }));
}

beforeEach(() => {
  workdir = initRepo();
  sandboxRoot = mkdtempSync(join(tmpdir(), "forge-api-sbx-"));
  relayConfigPath = join(mkdtempSync(join(tmpdir(), "forge-api-cfg-")), "relay.json");
  counterFile = join(mkdtempSync(join(tmpdir(), "forge-api-ctr-")), "counter.txt");
  process.env.VIBEOPS_SANDBOX_ROOT = sandboxRoot;
  process.env.VIBEOPS_RELAY_CONFIG = relayConfigPath;
  writeRelayConfig();
});

afterEach(() => {
  delete process.env.VIBEOPS_SANDBOX_ROOT;
  delete process.env.VIBEOPS_RELAY_CONFIG;
  delete process.env.FAKE_SCRIPT;
  delete process.env.FAKE_COUNTER_FILE;
  delete process.env.FAKE_WRITE;
  rmSync(workdir, { recursive: true, force: true });
  rmSync(sandboxRoot, { recursive: true, force: true });
});

function setScript(script: string, write?: boolean): void {
  process.env.FAKE_SCRIPT = script;
  process.env.FAKE_COUNTER_FILE = counterFile;
  if (write) process.env.FAKE_WRITE = "1";
  else delete process.env.FAKE_WRITE;
}

async function pollUntilDone(h: Record<string, string>, runId: string): Promise<{ status: string }> {
  const deadline = Date.now() + 30_000;
  let after = 0;
  for (;;) {
    const res = await app.request(`/forge/runs/${runId}/output?after=${after}`, { headers: h });
    const body = await res.json();
    if (body.status !== "running") return body;
    after = body.next;
    if (Date.now() > deadline) throw new Error("run did not finish within 30s");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("forge API", () => {
  it("GET /forge/agents lists agents by name/roles and never a cmd", async () => {
    const h = await adminHeaders();
    const res = await app.request("/forge/agents", { headers: h });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([{ name: "fake", roles: ["plan", "work", "review"] }]);
    expect(JSON.stringify(body)).not.toContain("cmd");
  });

  it("GET /forge/skills lists skill directory names", async () => {
    mkdirSync(join(workdir, ".claude", "skills", "my-skill"), { recursive: true });
    const h = await adminHeaders();
    const res = await app.request("/forge/skills", { headers: h });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((s: { name: string }) => s.name)).toContain("my-skill");
  });

  it("GET /forge/runs/:id/output 404s for an unknown run id", async () => {
    const h = await adminHeaders();
    const res = await app.request("/forge/runs/00000000-0000-0000-0000-000000000000/output", { headers: h });
    expect(res.status).toBe(404);
  });

  it("pipeline runs end-to-end via output polling, then promote merges and closes the ticket", async () => {
    const h = await adminHeaders();
    const ticket = await seedTicket();
    setScript("plan,work,review-pass", true);

    const startRes = await app.request("/forge/pipeline", {
      method: "POST", headers: h,
      body: JSON.stringify({ ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake" }),
    });
    expect(startRes.status).toBe(201);
    const { runId } = await startRes.json();

    const runsRes = await app.request("/forge/runs", { headers: h });
    expect((await runsRes.json()).some((r: { id: string }) => r.id === runId)).toBe(true);

    const final = await pollUntilDone(h, runId);
    expect(final.status).toBe("passed");

    const sandboxRes = await app.request(`/forge/tickets/${ticket.id}/sandbox`, { headers: h });
    const sandboxBody = await sandboxRes.json();
    expect(sandboxBody).toEqual({ exists: true, branch: `forge/${ticket.id}`, lastVerdict: "pass" });

    const diffRes = await app.request(`/forge/tickets/${ticket.id}/diff`, { headers: h });
    expect(diffRes.status).toBe(200);
    expect((await diffRes.json()).diff).toContain("forge-made.txt");

    const promoteRes = await app.request(`/forge/tickets/${ticket.id}/promote`, { method: "POST", headers: h });
    expect(promoteRes.status).toBe(200);
    expect((await promoteRes.json()).status).toBe("closed");

    const afterPromote = await app.request(`/forge/tickets/${ticket.id}/sandbox`, { headers: h });
    expect((await afterPromote.json()).exists).toBe(false);
  });

  it("promote without a passing review returns 409", async () => {
    const h = await adminHeaders();
    const ticket = await seedTicket();
    setScript("plan,work,review-fail", true);

    const startRes = await app.request("/forge/pipeline", {
      method: "POST", headers: h,
      body: JSON.stringify({ ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake" }),
    });
    const { runId } = await startRes.json();
    await pollUntilDone(h, runId);

    const promoteRes = await app.request(`/forge/tickets/${ticket.id}/promote`, { method: "POST", headers: h });
    expect(promoteRes.status).toBe(409);
  });

  it("discard removes the sandbox and bounces a review-status ticket to planned", async () => {
    const h = await adminHeaders();
    const ticket = await seedTicket();
    setScript("plan,work,review-pass", true);

    const startRes = await app.request("/forge/pipeline", {
      method: "POST", headers: h,
      body: JSON.stringify({ ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake" }),
    });
    const { runId } = await startRes.json();
    await pollUntilDone(h, runId);

    const discardRes = await app.request(`/forge/tickets/${ticket.id}/discard`, { method: "POST", headers: h });
    expect(discardRes.status).toBe(200);
    expect((await discardRes.json()).status).toBe("planned");

    const sandboxRes = await app.request(`/forge/tickets/${ticket.id}/sandbox`, { headers: h });
    expect((await sandboxRes.json()).exists).toBe(false);

    const discardAgain = await app.request(`/forge/tickets/${ticket.id}/discard`, { method: "POST", headers: h });
    expect(discardAgain.status).toBe(404);
  });

  it("POST /forge/pipeline returns 400 for missing fields and unknown agent", async () => {
    const h = await adminHeaders();
    const ticket = await seedTicket();

    const missing = await app.request("/forge/pipeline", {
      method: "POST", headers: h, body: JSON.stringify({ ticketId: ticket.id }),
    });
    expect(missing.status).toBe(400);

    const unknownAgent = await app.request("/forge/pipeline", {
      method: "POST", headers: h,
      body: JSON.stringify({ ticketId: ticket.id, planAgent: "nope", workAgent: "fake", reviewAgent: "fake" }),
    });
    expect(unknownAgent.status).toBe(400);
  });
});
