import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const h = vi.hoisted(() => ({ calls: [] as { write: boolean; hooked: boolean }[], failHook: false, workCount: 0 }));

vi.mock("../src/relay/dispatch.js", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  return {
    runAgent: async (agent: { cmd?: string[]; write?: boolean }, prompt: string, workdir: string) => {
      const cmd = agent.cmd ?? [];
      if (cmd.includes("--dangerously-skip-permissions")) {
        const f = path.join(workdir, ".agents", "hooks.json");
        let hooked = false;
        if (fs.existsSync(f)) hooked = "vibeops-firewall" in (JSON.parse(fs.readFileSync(f, "utf-8")) as object);
        h.calls.push({ write: !!agent.write, hooked });
      }
      if (agent.write) {
        h.workCount++;
        fs.writeFileSync(path.join(workdir, "forge-made.txt"), `v${h.workCount}\n`);
        return { ok: true, output: "done" };
      }
      return { ok: true, output: "1. do the thing\nFiles: forge-made.txt\nlooks good\nVERDICT: PASS" };
    },
  };
});
vi.mock("../src/relay/wall.js", async (orig) => {
  const real = await orig<typeof import("../src/relay/wall.js")>();
  return { ...real, agyFirewallHookCommand: () => { if (h.failHook) throw new Error("hook script missing"); return real.agyFirewallHookCommand(); } };
});

import { startPipeline, awaitRun, getRunOutput } from "../src/forge/runs.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { createTicket } from "../src/services/tickets.js";
import { withSetting } from "./helpers/settings.js";
import type { RelayConfig } from "../src/relay/config.js";

process.env.EMBED_PROVIDER = "fake";
const __dirname = dirname(fileURLToPath(import.meta.url));

function uniq(p: string) { return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
async function seedTicket(title: string) {
  const { actor } = await createActor({ name: uniq("agy-actor"), kind: "human", role: "admin" });
  const project = await createProject({ key: uniq("agy-proj"), name: "Forge" });
  const ticket = await createTicket(actor.id, { projectId: project.id, title });
  return { actorId: actor.id, ticket };
}

let workdir: string, sandboxRoot: string;
beforeEach(() => {
  h.calls.length = 0; h.failHook = false; h.workCount = 0;
  workdir = mkdtempSync(join(tmpdir(), "forge-agy-base-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: workdir });
  g("init", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(workdir, "readme.md"), "base\n");
  g("add", "-A"); g("commit", "-m", "base");
  sandboxRoot = mkdtempSync(join(tmpdir(), "forge-agy-sbx-"));
  process.env.VIBEOPS_SANDBOX_ROOT = sandboxRoot;
});
afterEach(() => {
  delete process.env.VIBEOPS_SANDBOX_ROOT;
  rmSync(workdir, { recursive: true, force: true });
  rmSync(sandboxRoot, { recursive: true, force: true });
});

function config(): RelayConfig {
  return {
    workdir,
    agents: {
      agy: {
        cmd: ["agy", "--model", "{model}", "--dangerously-skip-permissions", "--print-timeout", "30m"],
        roles: ["plan", "work", "review"],
        models: [{ name: "m", tier: "free", quality: 5 }],
      },
    },
  };
}
const names = { planAgent: "agy", workAgent: "agy", reviewAgent: "agy" };

describe("forge agy stages always carry the firewall hook", () => {
  it("plan, work and review all run hooked; no stray hook output", async () => {
    const { actorId, ticket } = await seedTicket("agy all stages");
    const { runId } = await startPipeline(actorId, config(), { ticketId: ticket.id, ...names });
    await awaitRun(runId);
    expect(h.calls.length).toBeGreaterThanOrEqual(3);
    expect(h.calls.every((c) => c.hooked)).toBe(true);
    const chunk = getRunOutput(runId, 0)?.chunk ?? "";
    expect(chunk).not.toContain("planner changed files in its read-only copy");
    expect(chunk).not.toContain("pipeline error");
  });

  it("pre-review retry runs hooked", async () => {
    const { actorId, ticket } = await seedTicket("agy retry");
    await withSetting("forge.preReviewCheck", "true", () =>
      withSetting("forge.checks", JSON.stringify([`node "${join(__dirname, "fixtures", "check-fail.mjs")}"`]), async () => {
        const { runId } = await startPipeline(actorId, config(), { ticketId: ticket.id, ...names });
        await awaitRun(runId);
        expect(getRunOutput(runId, 0)?.chunk ?? "").toContain("running local rework retry");
        expect(h.workCount).toBeGreaterThanOrEqual(2);
        expect(h.calls.length).toBeGreaterThanOrEqual(4);
        expect(h.calls.every((c) => c.hooked)).toBe(true);
      }));
  });

  it("hook install failure fails the run and agy is never spawned", async () => {
    h.failHook = true;
    const { actorId, ticket } = await seedTicket("agy hook fail");
    const { runId } = await startPipeline(actorId, config(), { ticketId: ticket.id, ...names });
    await awaitRun(runId);
    const out = getRunOutput(runId, 0);
    expect(out?.status).toBe("failed");
    expect(out?.chunk ?? "").toContain("pipeline error: hook script missing");
    expect(h.calls.length).toBe(0);
  });
});
