import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getLessons, setLessons, composeAnalyzerPrompt, parseProposal, formatProposal } from "../src/forge/lessons.js";
import { createActor } from "../src/services/actors.js";

process.env.EMBED_PROVIDER = "fake";

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("forge lessons", () => {
  it("parseProposal: each vocab kind parses", () => {
    expect(parseProposal(`PROPOSAL:\n{"decision":"propose","kind":"boot-sidecar"}`)).toEqual({ decision: "propose", kind: "boot-sidecar" });
    expect(parseProposal(`PROPOSAL:\n{"decision":"propose","kind":"npm-script","script":"typecheck"}`)).toEqual({ decision: "propose", kind: "npm-script", script: "typecheck" });
    expect(parseProposal(`PROPOSAL:\n{"decision":"propose","kind":"grep-diff","pattern":"node_modules/.vite-temp"}`)).toEqual({ decision: "propose", kind: "grep-diff", pattern: "node_modules/.vite-temp" });
  });

  it("parseProposal: decline preserved", () => {
    expect(parseProposal(`PROPOSAL:\n{"decision":"decline","reason":"no regression guard possible"}`)).toEqual({ decision: "decline", reason: "no regression guard possible" });
  });

  it("parseProposal: out-of-vocabulary propose coerced to decline (no escape hatch)", () => {
    expect(parseProposal(`PROPOSAL:\n{"decision":"propose","kind":"run-shell","cmd":"rm -rf /"}`)).toEqual({ decision: "decline", reason: "out-of-vocabulary proposal: run-shell" });
  });

  it("parseProposal: propose missing required params -> decline", () => {
    expect(parseProposal(`PROPOSAL:\n{"decision":"propose","kind":"npm-script"}`)).toEqual({ decision: "decline", reason: "out-of-vocabulary proposal: npm-script" });
    expect(parseProposal(`PROPOSAL:\n{"decision":"propose","kind":"grep-diff"}`)).toEqual({ decision: "decline", reason: "out-of-vocabulary proposal: grep-diff" });
  });

  it("parseProposal: no marker / non-object JSON -> null", () => {
    expect(parseProposal("just narration, no marker")).toBeNull();
    expect(parseProposal(`PROPOSAL:\nnot json`)).toBeNull();
    expect(parseProposal(`PROPOSAL:\n[1,2]`)).toBeNull();
  });

  it("parseProposal: real model outputs parse correctly", () => {
    const caseA = `PROPOSAL: {"decision":"decline","reason":"Junction leak writes into gitignored node_modules, so it never shows in the diff and no existing npm script or sidecar boot observes the filesystem side-effect."}`;
    expect(parseProposal(caseA)).toEqual({ decision: "decline", reason: "Junction leak writes into gitignored node_modules, so it never shows in the diff and no existing npm script or sidecar boot observes the filesystem side-effect." });

    const caseB = `PROPOSAL: {"decision":"propose","kind":"boot-sidecar"}\n\nReason: failure is bundle-only boot breakage dev mode hid — exactly what boot-sidecar catches. Both instances (import cycle, boot restructure) surface as sidecar fail-to-boot, mechanically reproducible by building payload + booting.`;
    expect(parseProposal(caseB)).toEqual({ decision: "propose", kind: "boot-sidecar" });

    const caseC = `PROPOSAL: {"decision":"decline","reason":"Missing regression guard is non-mechanical: no regex or script proves a test fails without the fix."}`;
    expect(parseProposal(caseC)).toEqual({ decision: "decline", reason: "Missing regression guard is non-mechanical: no regex or script proves a test fails without the fix." });

    const caseD = `PROPOSAL: {"decision":"decline","reason":"Test name-vs-behavior mismatch is semantic; no regex/script/boot can tell that a test labeled 'concurrent' runs serially."}`;
    expect(parseProposal(caseD)).toEqual({ decision: "decline", reason: "Test name-vs-behavior mismatch is semantic; no regex/script/boot can tell that a test labeled 'concurrent' runs serially." });
  });

  it("formatProposal renders each shape", () => {
    expect(formatProposal({ decision: "propose", kind: "boot-sidecar" })).toBe("PROPOSE check: boot-sidecar");
    expect(formatProposal({ decision: "propose", kind: "npm-script", script: "typecheck" })).toBe("PROPOSE check: npm-script typecheck");
    expect(formatProposal({ decision: "propose", kind: "grep-diff", pattern: "x" })).toBe("PROPOSE check: grep-diff /x/");
    expect(formatProposal({ decision: "decline", reason: "why" })).toBe("DECLINE: why");
  });

  it("composeAnalyzerPrompt asks for check-or-decline from the fixed vocabulary", () => {
    const prompt = composeAnalyzerPrompt({ output: "OUTPUT_MARKER", outcome: "status=failed stage=work" });
    expect(prompt).toContain("OUTPUT_MARKER");
    expect(prompt).toContain("status=failed stage=work");
    expect(prompt).toContain("boot-sidecar");
    expect(prompt).toContain("npm-script");
    expect(prompt).toContain("grep-diff");
    expect(prompt).toContain("DECLINE");
    expect(prompt).toContain("PROPOSAL:");
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
        if (proposal.includes("MARKER-LESSON-42")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(proposal).toContain("MARKER-LESSON-42");
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
