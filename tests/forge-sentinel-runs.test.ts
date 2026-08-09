import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { startPipeline, awaitRun, getRunOutput } from "../src/forge/runs.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { createTicket } from "../src/services/tickets.js";
import { withSetting } from "./helpers/settings.js";
import type { RelayConfig } from "../src/relay/config.js";

process.env.EMBED_PROVIDER = "fake";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(__dirname, "fixtures", "fake-agent.mjs");

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-sentinel-base-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  g("init", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(dir, "readme.md"), "base\n");
  g("add", "-A"); g("commit", "-m", "base");
  return dir;
}
function uniq(p: string) { return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
async function seedTicket(title: string) {
  const { actor } = await createActor({ name: uniq("sen-actor"), kind: "human", role: "admin" });
  const project = await createProject({ key: uniq("sen-proj"), name: "Forge" });
  const ticket = await createTicket(actor.id, { projectId: project.id, title });
  return { actorId: actor.id, ticket };
}

let workdir: string, sandboxRoot: string, sensitiveDir: string;

beforeEach(() => {
  // Clean env vars that might bleed from parallel test files
  delete process.env.FAKE_SCRIPT;
  delete process.env.FAKE_COUNTER_FILE;
  delete process.env.FAKE_WRITE_ABS;
  workdir = initRepo();
  sandboxRoot = mkdtempSync(join(tmpdir(), "forge-sentinel-sbx-"));
  sensitiveDir = mkdtempSync(join(tmpdir(), "forge-sentinel-app-"));
  process.env.VIBEOPS_SANDBOX_ROOT = sandboxRoot;
});
afterEach(() => {
  delete process.env.VIBEOPS_SANDBOX_ROOT;
  delete process.env.FAKE_SCRIPT; delete process.env.FAKE_COUNTER_FILE; delete process.env.FAKE_WRITE_ABS;
  rmSync(workdir, { recursive: true, force: true });
  rmSync(sandboxRoot, { recursive: true, force: true });
  rmSync(sensitiveDir, { recursive: true, force: true });
});

function config(): RelayConfig {
  return {
    workdir,
    agents: {
      fake: { cmd: [process.execPath, FAKE_AGENT, "{prompt}"], roles: ["plan", "work", "review"] },
    },
  };
}

describe("forge sandbox-escape sentinel (integration through runs.ts)", () => {
  it("reproduction: a work stage overwriting the installed server payload is reverted, surfaced, and fails the run", async () => {
    const { actorId, ticket } = await seedTicket("sentinel repro");
    // Stand in for %LOCALAPPDATA%\\VibeOps\\resources\\server\\server.mjs
    const installed = join(sensitiveDir, "server.mjs");
    writeFileSync(installed, "GOOD SERVER PAYLOAD\n");
    process.env.FAKE_SCRIPT = "plan,work,review-pass";
    process.env.FAKE_COUNTER_FILE = join(sensitiveDir, "ctr.txt");
    process.env.FAKE_WRITE_ABS = installed; // work agent escapes and overwrites it

    await withSetting("forge.sensitivePaths", JSON.stringify([installed]), async () => {
      const { runId } = await startPipeline(actorId, config(), {
        ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
      });
      await awaitRun(runId);
      const out = getRunOutput(runId, 0);
      expect(out?.status).toBe("failed");
      expect(out?.chunk).toContain("SANDBOX-ESCAPE");
      expect(out?.chunk).toContain(installed);
    });

    expect(readFileSync(installed, "utf-8")).toBe("GOOD SERVER PAYLOAD\n"); // reverted
  }, 20_000);

  it("a clean work stage that does not escape passes untouched", async () => {
    const { actorId, ticket } = await seedTicket("sentinel clean");
    const installed = join(sensitiveDir, "server.mjs");
    writeFileSync(installed, "GOOD SERVER PAYLOAD\n");
    process.env.FAKE_SCRIPT = "plan,work,review-pass";
    process.env.FAKE_COUNTER_FILE = join(sensitiveDir, "ctr.txt");
    // no FAKE_WRITE_ABS -> no escape

    await withSetting("forge.sensitivePaths", JSON.stringify([installed]), async () => {
      const { runId } = await startPipeline(actorId, config(), {
        ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
      });
      await awaitRun(runId);
      const out = getRunOutput(runId, 0);
      expect(out?.status).toBe("passed");
      expect(out?.chunk ?? "").not.toContain("SANDBOX-ESCAPE");
    });
    expect(readFileSync(installed, "utf-8")).toBe("GOOD SERVER PAYLOAD\n");
  }, 20_000);

  it("a work stage overwriting relay.json is reverted, surfaced, and fails the run", async () => {
    const { actorId, ticket } = await seedTicket("sentinel relay.json");
    // Stand in for ~/.vibeops/relay.json (the argv source for later runs).
    const relay = join(sensitiveDir, "relay.json");
    writeFileSync(relay, "GOOD RELAY CONFIG\n");
    process.env.FAKE_SCRIPT = "plan,work,review-pass";
    process.env.FAKE_COUNTER_FILE = join(sensitiveDir, "ctr.txt");
    process.env.FAKE_WRITE_ABS = relay; // work agent escapes and rewrites relay.json

    await withSetting("forge.sensitivePaths", JSON.stringify([relay]), async () => {
      const { runId } = await startPipeline(actorId, config(), {
        ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
      });
      await awaitRun(runId);
      const out = getRunOutput(runId, 0);
      expect(out?.status).toBe("failed");
      expect(out?.chunk).toContain("SANDBOX-ESCAPE");
      expect(out?.chunk).toContain(relay);
    });

    expect(readFileSync(relay, "utf-8")).toBe("GOOD RELAY CONFIG\n"); // reverted
  }, 20_000);
});
