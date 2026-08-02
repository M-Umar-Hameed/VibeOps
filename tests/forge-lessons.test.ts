import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getLessons, setLessons, composeAnalyzerPrompt, parseOps, applyOps } from "../src/forge/lessons.js";
import { createActor } from "../src/services/actors.js";

process.env.EMBED_PROVIDER = "fake";

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("forge lessons", () => {
  it("parseOps: valid OPS→ops (capped 3, ill-shaped dropped)", () => {
    const output = `analysis done\nOPS:\n[
      {"op":"add","text":"one"},
      {"op":"delete","target":"two"},
      {"op":"replace","target":"three","text":"four"},
      {"op":"add","text":"five"},
      {"op":"add"}
    ]`;
    const ops = parseOps(output);
    expect(ops).toEqual([
      { op: "add", text: "one" },
      { op: "delete", target: "two" },
      { op: "replace", target: "three", text: "four" }
    ]);
  });

  it("parseOps: no anchor -> null", () => {
    expect(parseOps("just some narration, no marker here")).toBeNull();
  });

  it("parseOps: malformed JSON / non-array -> null", () => {
    expect(parseOps("OPS:\n{ \"not\": \"an array\" }")).toBeNull();
    expect(parseOps("OPS:\nnot even json")).toBeNull();
  });

  it("applyOps: add/delete/replace apply on verbatim match", () => {
    const doc = "line1\nline2\nline3";
    const ops: any[] = [
      { op: "delete", target: "line2" },
      { op: "replace", target: "line3", text: "line3_new" },
      { op: "add", text: "line4" }
    ];
    const { doc: newDoc, applied, rejected } = applyOps(doc, ops);
    expect(newDoc).toBe("line1\nline3_new\nline4");
    expect(applied.length).toBe(3);
    expect(rejected.length).toBe(0);
  });

  it("applyOps: unknown target rejected without mutating doc", () => {
    const doc = "line1";
    const ops: any[] = [
      { op: "delete", target: "line2" },
      { op: "replace", target: "line3", text: "line3_new" }
    ];
    const { doc: newDoc, applied, rejected } = applyOps(doc, ops);
    expect(newDoc).toBe("line1");
    expect(applied.length).toBe(0);
    expect(rejected.length).toBe(2);
  });

  it("applyOps: 12-line cap enforced, redacted text", () => {
    const doc = Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n");
    const ops: any[] = [
      { op: "add", text: "line12" }, // should be rejected unless delete makes room
      { op: "add", text: "leaked sk-abcdefghij0123456789" }
    ];
    const res1 = applyOps(doc, ops);
    expect(res1.applied.length).toBe(0);
    expect(res1.rejected.length).toBe(2);

    const opsWithDelete: any[] = [
      { op: "delete", target: "line0" },
      { op: "add", text: "leaked sk-abcdefghij0123456789" }
    ];
    const res2 = applyOps(doc, opsWithDelete);
    expect(res2.applied.length).toBe(2);
    expect(res2.rejected.length).toBe(0);
    expect(res2.doc).not.toContain("sk-abcdefghij0123456789");
    expect(res2.doc).toContain("leaked [redacted]");
  });

  it("composeAnalyzerPrompt includes output, outcome, current, and hard-rule contract", () => {
    const prompt = composeAnalyzerPrompt({
      output: "OUTPUT_MARKER",
      outcome: "status=passed stage=review",
      current: "CURRENT_MARKER",
    });
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
import { getSetting } from "../src/services/settings.js";
import { listNotes } from "../src/services/notes.js";
import { randomUUID } from "node:crypto";
import { withSetting } from "./helpers/settings.js";
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

  beforeEach(async () => {
    workdir = initRepo();
    sandboxRoot = mkdtempSync(join(tmpdir(), "lessons-run-sbx-"));
    process.env.VIBEOPS_SANDBOX_ROOT = sandboxRoot;
    counterDir = mkdtempSync(join(tmpdir(), "lessons-run-ctr-"));
    counterFile = join(counterDir, "counter.txt");
  });

  afterEach(async () => {
    delete process.env.VIBEOPS_SANDBOX_ROOT;
    delete process.env.FAKE_SCRIPT;
    delete process.env.FAKE_COUNTER_FILE;
    delete process.env.FAKE_WRITE;
    rmSync(workdir, { recursive: true, force: true });
    rmSync(sandboxRoot, { recursive: true, force: true });
    rmSync(counterDir, { recursive: true, force: true });
  });

  it("selfImprove on: analyzer records a proposal and never writes the live note", async () => {
    const { actorId, ticket } = await seedTicket("Lessons happy path");
    const SENTINEL = `live-untouched-${randomUUID()}`;
    await setLessons(actorId, SENTINEL); // known live-note body; must stay unchanged
    process.env.FAKE_SCRIPT = "plan,work,review-pass,analyzer";
    process.env.FAKE_COUNTER_FILE = counterFile;
    process.env.FAKE_WRITE = "1";

    await withSetting("prompts.selfImprove", "true", async () => {
      const { runId } = await startPipeline(actorId, relayConfig(workdir), {
        ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
      });
      await awaitRun(runId);

      // proposal lands in the SEPARATE proposals note; SENTINEL makes it this run's
      const start = Date.now();
      let proposal = "";
      while (Date.now() - start < 5000) {
        const rows = await listNotes({ scope: "global" });
        proposal = rows.find((n) => n.title === "prompt-lessons-proposals")?.body ?? "";
        if (proposal.includes(SENTINEL) && proposal.includes("MARKER-LESSON-42")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(proposal).toContain("MARKER-LESSON-42");
      expect(proposal).toContain(SENTINEL);
      // the automated path must NOT have touched the live prompt-lessons note
      expect(await getLessons()).toBe(SENTINEL);
    });
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

    await new Promise((r) => setTimeout(r, 300));
    expect(readFileSync(counterFile, "utf-8")).toBe("3");
  });
});
