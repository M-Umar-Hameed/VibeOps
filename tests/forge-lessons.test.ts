import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { getLessons, setLessons, lessonsClause } from "../src/forge/lessons.js";
import { startPipeline, awaitRun } from "../src/forge/runs.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { createTicket } from "../src/services/tickets.js";
import { randomUUID } from "node:crypto";
import type { RelayConfig } from "../src/relay/config.js";

const uniq = (p: string) => `${p}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const __dirname2 = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(__dirname2, "fixtures", "fake-agent.mjs");

describe("lessonsClause", () => {
  // The only surviving consumer of the lessons note: it is injected into every
  // PLAN prompt. Measured 2026-08-12 to change plan behaviour (a contradictory
  // ticket gets blocked rather than planned), which is why the plan-stage
  // injection was kept when the analyzer was deleted.
  it("wraps the note with the follow-these preamble", () => {
    expect(lessonsClause("1. do the thing")).toContain("Prompting lessons learned");
    expect(lessonsClause("1. do the thing")).toContain("1. do the thing");
  });

  it("contributes nothing when the note is empty", () => {
    expect(lessonsClause("")).toBe("");
  });

  it("round-trips through the note store", async () => {
    const { actor } = await createActor({ name: uniq("lessons-actor"), kind: "human" });
    const body = `lesson-${randomUUID()}`;
    await setLessons(actor.id, body);
    expect(await getLessons()).toBe(body);
  });
});

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "lessons-run-base-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  g("init", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "readme.md"), "base\n");
  g("add", "-A");
  g("commit", "-m", "base");
  return dir;
}

function relayConfig(workdir: string): RelayConfig {
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

describe("forge pipeline agent invocations", () => {
  let workdir: string;
  let counterDir: string;
  let counterFile: string;
  let sandboxRoot: string;

  beforeAll(() => {
    workdir = initRepo();
    counterDir = mkdtempSync(join(tmpdir(), "lessons-ctr-"));
    counterFile = join(counterDir, "count.txt");
    sandboxRoot = mkdtempSync(join(tmpdir(), "lessons-sbx-"));
    process.env.VIBEOPS_SANDBOX_ROOT = sandboxRoot;
  });
  afterAll(() => {
    // Deliberately NOT deleting VIBEOPS_SANDBOX_ROOT. It is a process-wide global
    // that other forge suites read, and this file finishes early — clearing it
    // mid-flight pulled the sandbox root out from under forge-runs and failed
    // hasActiveRun there. Leaving a stale path is harmless; each suite sets its own.
    delete process.env.FAKE_SCRIPT;
    delete process.env.FAKE_COUNTER_FILE;
    delete process.env.FAKE_WRITE;
    for (const d of [workdir, counterDir, sandboxRoot]) rmSync(d, { recursive: true, force: true });
  });

  // Kept from the deleted analyzer suite as its regression guard. The
  // self-improvement analyzer used to fire a FOURTH agent call after every
  // settled run; it was removed because it produced one useful proposal across
  // four scored failures (duplicating a check that already existed) into a note
  // nothing read. If this count ever returns to 4, something re-added a
  // post-settle model call.
  it("a run costs exactly three agent calls: plan, work, review", async () => {
    const { actor } = await createActor({ name: uniq("lessons-actor"), kind: "human" });
    const project = await createProject({ key: uniq("lessons-proj"), name: "Lessons" });
    const ticket = await createTicket(actor.id, { projectId: project.id, title: "Invocation count" });

    process.env.FAKE_SCRIPT = "plan,work,review-pass";
    process.env.FAKE_COUNTER_FILE = counterFile;
    process.env.FAKE_WRITE = "1";

    const { runId } = await startPipeline(actor.id, relayConfig(workdir), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    // The analyzer was fire-and-forget after settle, so a late 4th call would land
    // shortly after awaitRun resolved. Give it room to show up before asserting.
    await new Promise((r) => setTimeout(r, 300));
    expect(readFileSync(counterFile, "utf-8")).toBe("3");
  }, 15_000);
});
