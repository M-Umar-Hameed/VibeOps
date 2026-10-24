import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { startPipeline, awaitRun, getRunOutput } from "../src/forge/runs.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { createTicket } from "../src/services/tickets.js";
import { db } from "../src/db/client.js";
import { forgeRuns } from "../src/db/schema.js";
import type { RelayConfig, RelayAccount } from "../src/relay/config.js";

process.env.EMBED_PROVIDER = "fake";
const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(__dirname, "fixtures", "fake-agent.mjs");

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-acct-base-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  g("init", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(dir, "readme.md"), "base\n");
  g("add", "-A"); g("commit", "-m", "base");
  return dir;
}
function uniq(p: string) { return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
async function seedTicket(title: string) {
  const { actor } = await createActor({ name: uniq("acct-actor"), kind: "human", role: "admin" });
  const project = await createProject({ key: uniq("acct-proj"), name: "Forge" });
  const ticket = await createTicket(actor.id, { projectId: project.id, title });
  return { actorId: actor.id, ticket };
}

let workdir: string, sandboxRoot: string, scratch: string, bin: string;
beforeEach(() => {
  workdir = initRepo();
  sandboxRoot = mkdtempSync(join(tmpdir(), "forge-acct-sbx-"));
  scratch = mkdtempSync(join(tmpdir(), "forge-acct-scratch-"));
  process.env.VIBEOPS_SANDBOX_ROOT = sandboxRoot;
  bin = join(scratch, process.platform === "win32" ? "codex.exe" : "codex");
  copyFileSync(process.execPath, bin);
  chmodSync(bin, 0o755);
});
afterEach(() => {
  delete process.env.VIBEOPS_SANDBOX_ROOT;
  for (const d of [workdir, sandboxRoot, scratch]) rmSync(d, { recursive: true, force: true });
});

function config(accounts?: RelayAccount[]): RelayConfig {
  const env = { FAKE_SCRIPT: "plan,work,review-pass", FAKE_COUNTER_FILE: join(scratch, "ctr.txt") };
  return { workdir, agents: { fake: { cmd: [bin, FAKE_AGENT, "{prompt}"], roles: ["plan", "work", "review"], env, ...(accounts ? { accounts } : {}) } } };
}

describe("forge run records the subscription account", () => {
  it("stores the lowest-priority account per stage", async () => {
    const { actorId, ticket } = await seedTicket("acct run");
    const { runId } = await startPipeline(actorId, config([
      { id: "backup", label: "B", configDir: join(scratch, "b"), priority: 2 },
      { id: "main", label: "A", configDir: join(scratch, "a"), priority: 1 },
    ]), { ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake" });
    await awaitRun(runId);
    expect(getRunOutput(runId, 0)?.status).toBe("passed");
    const [row] = await db.select().from(forgeRuns).where(eq(forgeRuns.id, runId));
    expect(row.accounts).toEqual({ plan: "main", work: "main", review: "main" });
  }, 30_000);

  it("leaves accounts null for a lane without accounts", async () => {
    const { actorId, ticket } = await seedTicket("acct none");
    const { runId } = await startPipeline(actorId, config(), { ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake" });
    await awaitRun(runId);
    const [row] = await db.select().from(forgeRuns).where(eq(forgeRuns.id, runId));
    expect(row.accounts).toBeNull();
  }, 30_000);
});
