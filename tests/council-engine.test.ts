import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { startCouncil, getCouncil, getCouncilOutput, submitAnswers, createTicketFromCouncil } from "../src/council/runs.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { ConflictError } from "../src/services/errors.js";
import type { RelayConfig } from "../src/relay/config.js";
import { getTicket } from "../src/services/history.js";

process.env.EMBED_PROVIDER = "fake";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(__dirname, "fixtures", "fake-agent.mjs");

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "council-run-base-"));
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

let workdir: string;
let counterDir: string;
let counterFile: string;

beforeEach(() => {
  workdir = initRepo();
  counterDir = mkdtempSync(join(tmpdir(), "council-run-ctr-"));
  counterFile = join(counterDir, "counter.txt");
});

afterEach(() => {
  delete process.env.FAKE_SCRIPT;
  delete process.env.FAKE_COUNTER_FILE;
  delete process.env.FAKE_WRITE;
  rmSync(workdir, { recursive: true, force: true });
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

async function waitForStatus(id: string, statuses: string[], timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const council = getCouncil(id);
    if (statuses.includes(council.status)) return council;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for status ${statuses.join("|")}`);
}

describe("council engine", () => {
  it("(a) evaluate with FAKE_SCRIPT 'persona,persona,persona,chairman-go'", async () => {
    const { actor } = await createActor({ name: uniq("council-actor"), kind: "human" });
    setScript("persona,persona,persona,chairman-go");

    const { councilId } = await startCouncil(actor.id, relayConfig(), { prompt: "a prompt long enough to pass" });
    const c = await waitForStatus(councilId, ["decided"]);
    
    expect((c as any).rating).toBe(8);
    expect((c as any).decision).toBe("GO");
    
    const out = getCouncilOutput(councilId, 0);
    expect(out?.chunk).toContain("=== COUNCIL believer ===");
    expect(out?.chunk).toContain("=== COUNCIL investor ===");
    expect(out?.chunk).toContain("=== COUNCIL skeptic ===");
    expect(out?.chunk).toContain("=== COUNCIL chairman ===");
  });

  it("(b) 'persona,persona,persona,chairman-questions' -> submitAnswers", async () => {
    const { actor } = await createActor({ name: uniq("council-actor"), kind: "human" });
    setScript("persona,persona,persona,chairman-questions");

    const { councilId } = await startCouncil(actor.id, relayConfig(), { prompt: "a prompt long enough to pass" });
    const c = await waitForStatus(councilId, ["awaiting-answers"]);
    
    expect((c as any).questions).toHaveLength(2);
    expect(c.status).toBe("awaiting-answers");

    // After submitAnswers, the next run will be chairman-go
    setScript("chairman-go");
    await submitAnswers(councilId, relayConfig(), ["a", "b"]);
    const c2 = await waitForStatus(councilId, ["decided"]);
    expect(c2.status).toBe("decided");
    expect((c2 as any).decision).toBe("GO");
  });

  it("(c) create-ticket on GO creates a ticket, session consumed, second create ConflictError", async () => {
    const { actor } = await createActor({ name: uniq("council-actor"), kind: "human" });
    const project = await createProject({ key: uniq("proj"), name: "Proj" });
    setScript("persona,persona,persona,chairman-go");

    const { councilId } = await startCouncil(actor.id, relayConfig(), { prompt: "a prompt long enough to pass" });
    await waitForStatus(councilId, ["decided"]);
    
    const ticket = await createTicketFromCouncil(actor.id, councilId, project.id);
    expect(ticket).toBeDefined();
    
    const t = await getTicket(ticket.id);
    expect(t.body).toContain("---\nCouncil verdict: 8/10 GO (round 1)");
    
    const c = getCouncil(councilId);
    expect(c.status).toBe("consumed");

    await expect(createTicketFromCouncil(actor.id, councilId, project.id)).rejects.toThrow(ConflictError);
  });

  it("(d) create-ticket on NEEDS-INFO without force -> ConflictError, with force -> ticket", async () => {
    const { actor } = await createActor({ name: uniq("council-actor"), kind: "human" });
    const project = await createProject({ key: uniq("proj"), name: "Proj" });
    setScript("persona,persona,persona,chairman-questions");

    const { councilId } = await startCouncil(actor.id, relayConfig(), { prompt: "a prompt long enough to pass" });
    await waitForStatus(councilId, ["awaiting-answers"]);
    
    await expect(createTicketFromCouncil(actor.id, councilId, project.id)).rejects.toThrow(ConflictError);
    
    const ticket = await createTicketFromCouncil(actor.id, councilId, project.id, true);
    expect(ticket).toBeDefined();
  });

  it("(e) prompt too short -> error", async () => {
    const { actor } = await createActor({ name: uniq("council-actor"), kind: "human" });
    await expect(startCouncil(actor.id, relayConfig(), { prompt: "short" })).rejects.toThrow("prompt must be between 10 and 10000 characters");
  });
});
