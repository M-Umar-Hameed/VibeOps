import { existsSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { startTimeReader } from "../runtime/proc-start.js";
import { loadRelayConfig } from "../relay/config.js";
import { db } from "../db/client.js";
import { pidAlive } from "../db/lifecycle.js";
import { forgeRuns, type ForgeRun } from "../db/schema.js";
import { isNull, eq } from "drizzle-orm";
import { bump } from "../services/metrics.js";
import { type Run, type Stage, type Effort, runs, append, setCause, settle } from "./run-state.js";

const REATTACH_POLL_MS = 200;

// Rebuild a minimal in-memory Run for an agent process that SURVIVED an API
// restart (S2-A2 spawns detached+unref'd, writing stdout to logPath). Resumes
// tailing the log from the CURRENT offset so live output continues, and polls
// the pid; when the orphan finally exits its supervising pipeline is gone (that
// continuation is S2-B), so the run settles interrupted with output intact and
// the existing listInterruptedRuns resume path applies.
function reattach(row: ForgeRun): void {
  try { loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG); } catch { /* no config: nothing to register */ }
  const run: Run = {
    id: row.id, ticketId: row.ticketId, stage: row.stage as Stage, status: "running",
    agents: { plan: row.planAgent, work: row.workAgent, review: row.reviewAgent },
    effort: (row.effort ?? undefined) as Effort | undefined,
    protectedViolations: row.protectedViolations ?? undefined,
    checksDurationMs: row.checksDurationMs ?? undefined,
    pid: row.pid ?? undefined,
    logPath: row.logPath!, runToken: row.runToken!,
    procStartedAt: row.procStartedAt ?? undefined,
    accounts: row.accounts ?? undefined,
    output: "", startedAt: row.startedAt.toISOString(), stopped: false,
    done: Promise.resolve(),
  };
  runs.set(run.id, run);
  run.done = tailUntilExit(run).then(() => run.persisted).catch(() => {});
}

function tailUntilExit(run: Run): Promise<void> {
  return new Promise<void>((resolve) => {
    const pid = run.pid;
    let readFd: number | undefined;
    let tailPos = 0;
    try {
      if (existsSync(run.logPath)) { readFd = openSync(run.logPath, "r"); tailPos = fstatSync(readFd).size; }
    } catch { readFd = undefined; }
    const drain = () => {
      if (readFd === undefined) return;
      try {
        const size = fstatSync(readFd).size;
        if (size <= tailPos) return;
        const buf = Buffer.allocUnsafe(size - tailPos);
        const n = readSync(readFd, buf, 0, size - tailPos, tailPos);
        tailPos += n;
        append(run, buf.toString("utf-8", 0, n));
      } catch { /* log rotated/removed under us */ }
    };
    const timer = setInterval(() => {
      if (run.stallReason && !run.finishedAt) { drain(); return; } // the stall sweep is saving work; it settles
      drain();
      if (run.stopped || pid === undefined || !pidAlive(pid)) {
        clearInterval(timer);
        drain();
        if (readFd !== undefined) { try { closeSync(readFd); } catch { /* best effort */ } }
        setCause(run, run.stopped ? "stopped" : "interrupted");
        settle(run, run.stopped ? "stopped" : "interrupted");
        resolve();
      }
    }, REATTACH_POLL_MS);
    timer.unref();
  });
}

export async function markInterruptedRuns(): Promise<string[]> {
  try {
    const rows = await db.select().from(forgeRuns).where(isNull(forgeRuns.finishedAt));
    const interrupted: string[] = [];
    let reattached = 0;
    for (const row of rows) {
      // A run THIS process still tracks is not a restart casualty; never touch it.
      if (runs.has(row.id)) continue;
      // Alive AND provably still our child: its CURRENT OS start time equals the
      // one persisted at spawn. A recycled pid is a different process with a
      // different start time -> mismatch -> falls through to interrupt. That guard
      // is the point of this ticket; do NOT weaken it to a pid-only or file-token
      // compare (a recycled pid would be adopted, losing S2-A3's protection).
      if (row.pid != null && row.logPath && row.procStartedAt
          && pidAlive(row.pid) && startTimeReader.read(row.pid) === row.procStartedAt) {
        reattach(row);
        reattached++;
        continue;
      }
      await db.update(forgeRuns)
        .set({ status: "interrupted", finishedAt: new Date(), cause: "interrupted" })
        .where(eq(forgeRuns.id, row.id));
      interrupted.push(row.ticketId);
    }
    bump("runs.interrupted", interrupted.length);
    if (reattached) console.log(`forge: reattached ${reattached} surviving run(s)`);
    return interrupted;
  } catch (e) {
    console.warn("forge: failed to mark interrupted runs:", (e as Error).message);
    return [];
  }
}
