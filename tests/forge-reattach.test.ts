import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { markInterruptedRuns, getRunOutput, awaitRun } from "../src/forge/runs.js";
import { db } from "../src/db/client.js";
import { forgeRuns } from "../src/db/schema.js";

process.env.EMBED_PROVIDER = "fake";

const LINUX = process.platform === "linux";
const spawned: number[] = [];

// A real, live process carrying (or not) VIBEOPS_RUN_TOKEN in its environment.
function sleeper(token?: string): number {
  const env = { ...process.env };
  if (token !== undefined) env.VIBEOPS_RUN_TOKEN = token; else delete env.VIBEOPS_RUN_TOKEN;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"],
    { env, stdio: "ignore", detached: true });
  child.unref();
  spawned.push(child.pid!);
  return child.pid!;
}

function kill(pid: number) { try { process.kill(pid); } catch { /* already gone */ } }

async function poll(fn: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("poll timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function tmpLog(): string {
  const p = join(mkdtempSync(join(tmpdir(), "reattach-log-")), "run.log");
  writeFileSync(p, "pre-restart output\n");
  return p;
}

async function insertRow(v: { pid: number | null; logPath: string; runToken: string }): Promise<string> {
  const id = randomUUID();
  await db.insert(forgeRuns).values({
    id, ticketId: randomUUID(), status: "running", stage: "work",
    planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
    pid: v.pid, logPath: v.logPath, runToken: v.runToken,
    startedAt: new Date(), finishedAt: null,
  });
  return id;
}

afterEach(() => { while (spawned.length) kill(spawned.pop()!); });

describe("forge boot reattach", () => {
  it.skipIf(!LINUX)("live pid + matching token: reattached, not interrupted, output continues from the log", async () => {
    const token = randomUUID();
    const pid = sleeper(token);
    const logPath = tmpLog();
    const id = await insertRow({ pid, logPath, runToken: token });

    const marked = await markInterruptedRuns();

    const [row] = await db.select().from(forgeRuns).where(eq(forgeRuns.id, id));
    expect(row.status).toBe("running");            // NOT interrupted at boot
    expect(row.finishedAt).toBeNull();
    expect(marked).not.toContain(row.ticketId);
    expect(getRunOutput(id, 0)?.status).toBe("running");

    // Output continues from the log (tail resumes at the current offset).
    appendFileSync(logPath, "LIVE-AFTER-REATTACH\n");
    await poll(() => (getRunOutput(id, 0)?.chunk ?? "").includes("LIVE-AFTER-REATTACH"));

    // Orphan exits -> run settles interrupted (verdict continuation is S2-B).
    kill(pid);
    await poll(() => getRunOutput(id, 0)?.status !== "running");
    await awaitRun(id);
    const [settled] = await db.select().from(forgeRuns).where(eq(forgeRuns.id, id));
    expect(settled.status).toBe("interrupted");
  }, 15000);

  it("dead pid: marked interrupted, exactly as today", async () => {
    const pid = sleeper(randomUUID());
    kill(pid);
    await poll(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    const id = await insertRow({ pid, logPath: tmpLog(), runToken: randomUUID() });

    const marked = await markInterruptedRuns();
    const [row] = await db.select().from(forgeRuns).where(eq(forgeRuns.id, id));
    expect(row.status).toBe("interrupted");
    expect(row.finishedAt).not.toBeNull();
    expect(marked).toContain(row.ticketId);
  });

  it("live pid + NON-matching token: interrupted, never adopted (recycled-pid guard)", async () => {
    const pid = sleeper(randomUUID());                              // live, unrelated token
    const id = await insertRow({ pid, logPath: tmpLog(), runToken: randomUUID() }); // different token

    const marked = await markInterruptedRuns();
    const [row] = await db.select().from(forgeRuns).where(eq(forgeRuns.id, id));
    expect(row.status).toBe("interrupted");
    expect(marked).toContain(row.ticketId);
    expect(getRunOutput(id, 0)).toBeUndefined();   // the stranger was never put in the runs map
  });
});
