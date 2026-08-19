import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { markInterruptedRuns, getRunOutput, awaitRun, stopRun, startTimeReader } from "../src/forge/runs.js";
import { pidAlive } from "../src/db/lifecycle.js";
import { db } from "../src/db/client.js";
import { forgeRuns } from "../src/db/schema.js";

process.env.EMBED_PROVIDER = "fake";

const spawned: number[] = [];
const originalStartReader = startTimeReader.read;

// A real, live process for the dead-pid test (the only test needing a real child).
function sleeper(): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"],
    { stdio: "ignore", detached: true });
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

async function insertRow(v: { pid: number | null; logPath: string; runToken: string; procStartedAt: string | null }): Promise<string> {
  const id = randomUUID();
  await db.insert(forgeRuns).values({
    id, ticketId: randomUUID(), status: "running", stage: "work",
    planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
    pid: v.pid, logPath: v.logPath, runToken: v.runToken, procStartedAt: v.procStartedAt,
    startedAt: new Date(), finishedAt: null,
  });
  return id;
}

afterEach(() => {
  while (spawned.length) kill(spawned.pop()!);
  startTimeReader.read = originalStartReader;
});

describe("forge boot reattach", () => {
  it("live pid + matching start time: reattached via the real OS reader, output continues from the log", async () => {
    const pid = sleeper();                          // real live child
    const started = startTimeReader.read(pid);      // real reader; must be non-null on this platform
    expect(started).not.toBeNull();
    const logPath = tmpLog();
    const id = await insertRow({ pid, logPath, runToken: randomUUID(), procStartedAt: started });

    const marked = await markInterruptedRuns();     // no stub: real reader re-reads the same start time

    const [row] = await db.select().from(forgeRuns).where(eq(forgeRuns.id, id));
    expect(row.status).toBe("running");
    expect(row.finishedAt).toBeNull();
    expect(marked).not.toContain(row.ticketId);
    expect(getRunOutput(id, 0)?.status).toBe("running");

    appendFileSync(logPath, "LIVE-AFTER-REATTACH\n");
    await poll(() => (getRunOutput(id, 0)?.chunk ?? "").includes("LIVE-AFTER-REATTACH"));

    kill(pid);
    await poll(() => getRunOutput(id, 0)?.status !== "running");
    await awaitRun(id);
    const [settled] = await db.select().from(forgeRuns).where(eq(forgeRuns.id, id));
    expect(settled.status).toBe("interrupted");
  }, 15000);

  it("dead pid: marked interrupted, exactly as today", async () => {
    const pid = sleeper();
    kill(pid);
    await poll(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    const id = await insertRow({ pid, logPath: tmpLog(), runToken: randomUUID(), procStartedAt: randomUUID() });

    const marked = await markInterruptedRuns();
    const [row] = await db.select().from(forgeRuns).where(eq(forgeRuns.id, id));
    expect(row.status).toBe("interrupted");
    expect(row.finishedAt).not.toBeNull();
    expect(marked).toContain(row.ticketId);
  });

  it("live pid + NON-matching start time: interrupted, never adopted (recycled-pid guard)", async () => {
    const pid = sleeper();
    const expected = "111111";
    const actual = "222222";                        // different start time = recycled pid
    const id = await insertRow({ pid, logPath: tmpLog(), runToken: randomUUID(), procStartedAt: expected });

    startTimeReader.read = (p: number) => (p === pid ? actual : null);

    const marked = await markInterruptedRuns();
    const [row] = await db.select().from(forgeRuns).where(eq(forgeRuns.id, id));
    expect(row.status).toBe("interrupted");
    expect(marked).toContain(row.ticketId);
    expect(getRunOutput(id, 0)).toBeUndefined();    // stranger never entered the runs map
  });

  it("stopping a reattached run actually kills the process", async () => {
    const pid = sleeper(); // Real live pid
    const logPath = tmpLog();
    const started = "424242";
    const id = await insertRow({ pid, logPath, runToken: randomUUID(), procStartedAt: started });

    startTimeReader.read = (p: number) => (p === pid ? started : null);

    const marked = await markInterruptedRuns();
    const [row] = await db.select().from(forgeRuns).where(eq(forgeRuns.id, id));
    expect(row.status).toBe("running");
    expect(marked).not.toContain(row.ticketId);
    expect(pidAlive(pid)).toBe(true);

    const stopped = await stopRun(id);
    expect(stopped).toBe(true);
    expect(pidAlive(pid)).toBe(false);

    await awaitRun(id);
    const [settled] = await db.select().from(forgeRuns).where(eq(forgeRuns.id, id));
    expect(settled.status).toBe("stopped");
  });
});
