import { statSync } from "node:fs";
import { treeCpuReader } from "../runtime/proc-tree-cpu.js";
import { killTree, killPidTree } from "../relay/invoke.js";
import { forgeCommit } from "./sandbox.js";
import { getTicket } from "../services/history.js";
import { listActors } from "../services/actors.js";
import { getSetting } from "../services/settings.js";
import { activeRuns, setCause, settle, bounce, append } from "./run-state.js";

// Server-side stall detector. Silence in both the log and process-tree CPU is
// the signal: a run whose log file has not grown and whose process tree used no
// CPU for windowMs is wedged (agent alive but blocked, typically on a child `npm
// test` that never exits), while a legitimately long stage narrates or runs tests
// so its clock keeps resetting. The per-child setTimeout in invoke.ts cannot
// cover this — it dies with the API process on restart and is never re-armed for
// a reattached run (tailUntilExit only polls pidAlive), so a wedged survivor runs
// forever. Settle such runs FAILED with a reason naming the stall, save WIP
// work in the sandbox, NOT interrupted (interrupted offers resume as if nothing
// were wrong).
const DEFAULT_STALL_WINDOW_MS = 30 * 60_000;

export function resolveStallWindowMs(setting: string | null): number {
  const n = parseInt(setting ?? "", 10);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_STALL_WINDOW_MS;
}

// Injectable so tests drive size growth without a real file. ponytail: statSync
// on the path — size, not mtime (NTFS lazily updates mtime for an open append
// handle, which the live tail's own fstatSync(size) path already works around).
export const logSizeReader = {
  read(logPath: string): number | null {
    try { return statSync(logPath).size; } catch { return null; }
  },
};

// At least 1s of tree CPU since the previous sweep (60s cadence in server.ts,
// so about 1.7% of one core) counts as activity. An idle agent blocked on a
// wedged child stays under it.
const BUSY_CPU_MS = 1000;

export async function sweepStalledRuns(now: number, windowMs: number): Promise<string[]> {
  const stalled: string[] = [];
  for (const run of activeRuns()) {
    try {
      if (run.stallReason) { setCause(run, "stall", run.stallReason); settle(run, "failed"); continue; } // pipeline never resumed after the kill (child refused to die): force terminal
      if (run.checksChild) { run.lastActivityAt = now; continue; } // checks own the run while they execute; their silence is not a stall
      const size = logSizeReader.read(run.logPath);
      if (size === null) { run.lastActivityAt ??= now; continue; }
      const cpu = run.pid != null ? treeCpuReader.read(run.pid) : null;
      const grew = run.lastLogSize === undefined || size > run.lastLogSize;
      const busy = cpu !== null && (run.lastCpuMs === undefined || cpu - run.lastCpuMs >= BUSY_CPU_MS);
      run.lastLogSize = size;
      if (cpu !== null) run.lastCpuMs = cpu;
      if (grew || busy) { run.lastActivityAt = now; continue; }
      const since = run.lastActivityAt ?? now;
      if (now - since <= windowMs) continue;
      const mins = Math.round((now - since) / 60_000);
      const iso = new Date(since).toISOString().replace(/\.\d{3}Z$/, "Z");
      const reason = `stopped by the stall timer after ${mins} minutes without activity in ${run.stage} stage (last activity ${iso})`;
      const pid = run.pid;
      const child = run.child ?? run.checksChild;
      run.stallReason = reason;
      if (child) {
        // In-process pipeline awaits this child: it WIP-commits, reports and settles (bounce lands inside the run window).
        await killTree(child);
        if (run.checksChild && run.checksChild !== child) await killTree(run.checksChild);
      } else {
        // Reattached survivor: no pipeline left to save its work. tailUntilExit holds off settling while stallReason is set.
        try {
          if (pid) await killPidTree(pid);
          let note = "";
          if (run.stage === "work" && await forgeCommit(run.ticketId, `WIP (stalled) ${(await getTicket(run.ticketId)).title}`)) note = "\n\n[forge: uncommitted work was saved to the sandbox branch as a WIP commit; promote or discard after review]";
          const admin = (await listActors()).find((a) => a.role === "admin");
          if (admin) await bounce(run, admin.id, reason, note);
          else append(run, `\nforge: ${reason}\n`);
        } finally { setCause(run, "stall", reason); settle(run, "failed"); }
      }
      stalled.push(run.id);
    } catch (e) {
      // One run's failure must never abort the sweep and starve every other run of
      // judgement (root cause of incident 6e3dcc32: a throwing sweep body under the
      // .catch(()=>{}) in server.ts made a wedged run immortal). Surface and continue.
      console.warn(`forge: stall sweep skipped run ${run.id}: ${(e as Error).message}`);
    }
  }
  return stalled;
}

// Production entry: read the configured window and sweep once. Wired to a server
// interval (see src/api/server.ts).
export async function sweepStalledRunsWithConfig(now = Date.now()): Promise<string[]> {
  const windowMs = resolveStallWindowMs(await getSetting("forge.stallWindowMs"));
  return sweepStalledRuns(now, windowMs);
}
