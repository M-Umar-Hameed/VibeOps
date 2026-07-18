import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getLessons, setLessons, lessonsClause, composeAnalyzerPrompt, parseLessons } from "../src/forge/lessons.js";
import { createActor } from "../src/services/actors.js";

process.env.EMBED_PROVIDER = "fake";

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("forge lessons", () => {
  it("parseLessons: well-formed block", () => {
    const output = "analysis done\nLESSONS:\n- one\n- two";
    expect(parseLessons(output)).toBe("- one\n- two");
  });

  it("parseLessons: garbage output -> null", () => {
    expect(parseLessons("just some narration, no marker here")).toBeNull();
  });

  it("parseLessons: last line-anchored block beats earlier narration", () => {
    const output = "LESSONS:\nold doc\n\nmore narration mentions LESSONS: inline, not anchored\n\nLESSONS:\nnew doc";
    expect(parseLessons(output)).toBe("new doc");
  });

  it("lessonsClause: empty vs filled", () => {
    expect(lessonsClause("")).toBe("");
    expect(lessonsClause("- do X")).toBe("\n\nPrompting lessons learned (follow these):\n- do X");
  });

  it("setLessons caps at 1500, redacts sk- keys, round-trips via getLessons", async () => {
    const { actor } = await createActor({ name: uniq("lessons-actor"), kind: "human" });
    const secret = "sk-abcdefghij0123456789";
    const longText = `leaked key ${secret}\n` + "x".repeat(2000);

    await setLessons(actor.id, longText);
    const stored = await getLessons();

    expect(stored.length).toBeLessThanOrEqual(1500);
    expect(stored).not.toContain(secret);

    await setLessons(actor.id, "- second write");
    expect(await getLessons()).toBe("- second write");
  });

  it("composeAnalyzerPrompt includes output, outcome, current, and the hard-rule contract", () => {
    const prompt = composeAnalyzerPrompt({ output: "OUTPUT_MARKER", outcome: "status=passed stage=review", current: "CURRENT_MARKER" });
    expect(prompt).toContain("OUTPUT_MARKER");
    expect(prompt).toContain("status=passed stage=review");
    expect(prompt).toContain("CURRENT_MARKER");
    expect(prompt).toContain("workers write files only, relative paths only, no git commits, REPORT:/VERDICT: contracts");
  });
});

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { startPipeline, awaitRun } from "../src/forge/runs.js";
import { createProject } from "../src/services/projects.js";
import { createTicket } from "../src/services/tickets.js";
import { getSetting, setSetting } from "../src/services/settings.js";
import type { RelayConfig } from "../src/relay/config.js";

const __dirname2 = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(__dirname2, "fixtures", "fake-agent.mjs");

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

async function seedTicket(title: string) {
  const { actor } = await createActor({ name: uniq("lessons-actor"), kind: "human" });
  const project = await createProject({ key: uniq("lessons-proj"), name: "Lessons" });
  const ticket = await createTicket(actor.id, { projectId: project.id, title });
  return { actorId: actor.id, ticket };
}

describe("forge lessons integration", () => {
  let workdir: string;
  let sandboxRoot: string;
  let counterDir: string;
  let counterFile: string;

  beforeEach(() => {
    workdir = initRepo();
    sandboxRoot = mkdtempSync(join(tmpdir(), "lessons-run-sbx-"));
    process.env.VIBEOPS_SANDBOX_ROOT = sandboxRoot;
    counterDir = mkdtempSync(join(tmpdir(), "lessons-run-ctr-"));
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

  it("selfImprove on: analyzer runs after settle and rewrites prompt-lessons", async () => {
    const { actorId, ticket } = await seedTicket("Lessons happy path");
    process.env.FAKE_SCRIPT = "plan,work,review-pass,analyzer";
    process.env.FAKE_COUNTER_FILE = counterFile;
    process.env.FAKE_WRITE = "1";

    await setSetting("prompts.selfImprove", "true");
    try {
      const { runId } = await startPipeline(actorId, relayConfig(workdir), {
        ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
      });
      await awaitRun(runId);

      const start = Date.now();
      let body = "";
      while (Date.now() - start < 5000) {
        body = await getLessons();
        if (body.includes("MARKER-LESSON-42")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(body).toContain("MARKER-LESSON-42");
    } finally {
      await setSetting("prompts.selfImprove", "");
    }
  }, 15_000);

  it("selfImprove unset: no 4th analyzer invocation", async () => {
    const { actorId, ticket } = await seedTicket("Lessons off path");
    process.env.FAKE_SCRIPT = "plan,work,review-pass";
    process.env.FAKE_COUNTER_FILE = counterFile;
    process.env.FAKE_WRITE = "1";

    expect(await getSetting("prompts.selfImprove")).not.toBe("true");
    const { runId } = await startPipeline(actorId, relayConfig(workdir), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    // give a would-be fire-and-forget analyzer call a moment to prove it does NOT happen
    await new Promise((r) => setTimeout(r, 300));
    expect(readFileSync(counterFile, "utf-8")).toBe("3");
  });
});
