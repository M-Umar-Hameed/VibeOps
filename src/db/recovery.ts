import { existsSync, writeFileSync, readFileSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { vibeopsHome } from "../runtime/home.js";
import type { Db, Dump } from "../services/backup.js";

export function recoveryMarkerPath(): string {
  return join(vibeopsHome(), ".vibeops", "recovery-pending");
}

export function markRecoveryPending(reason: string, now: string): void {
  try { writeFileSync(recoveryMarkerPath(), `${now} ${reason}\n`, { mode: 0o600 }); } catch {}
}

function newestExport(dir: string): string | null {
  try {
    const files = readdirSync(dir).filter((f) => f.startsWith("export-") && f.endsWith(".json")).sort();
    return files.length ? join(dir, files[files.length - 1]) : null;
  } catch { return null; }
}

// A successful boot with the marker present means the cluster was reopened after
// an unclean exit (manual pg_resetwal per docs). Diff live durable-table counts
// against the newest logical export and log what the reset discarded, then clear
// the marker. Reports only — never runs resetwal. Count deltas are a LOWER BOUND:
// in-place updates (e.g. ticket status changes) are not counted.
export async function reportAndClearRecovery(db: Db): Promise<string | null> {
  const marker = recoveryMarkerPath();
  if (!existsSync(marker)) return null;
  // Imported lazily: services/backup.js imports db from client.js, and client.js
  // dynamically imports THIS module from inside makeDb() on the corrupt path. A
  // static import there deadlocks ESM on client.js unsettled top-level await.
  const { backupDir, countDump, countTables } = await import("../services/backup.js");
  const newest = newestExport(backupDir());
  let report: string;
  if (!newest) {
    report = "recovery: cluster reopened after an unclean exit; no logical export exists to compare against — discarded work cannot be quantified. Check ~/.vibeops for known-good snapshots.";
  } else {
    const dump = JSON.parse(readFileSync(newest, "utf-8")) as Dump;
    const before = countDump(dump);
    const after = await countTables(db);
    const deltas = (Object.keys(before) as (keyof typeof before)[])
      .map((t) => ({ t, d: before[t] - after[t] }))
      .filter((x) => x.d !== 0);
    report = deltas.length
      ? `recovery: rows discarded vs newest export (${newest}): ` +
        deltas.map((x) => `${x.t} ${x.d > 0 ? "-" : "+"}${Math.abs(x.d)}`).join(", ") +
        ". In-place updates (e.g. status changes) are NOT counted; reconcile against the export."
      : `recovery: cluster reopened; durable row counts match newest export (${newest}). In-place updates after the last checkpoint may still be lost — reconcile if in doubt.`;
  }
  console.error(report);
  try { unlinkSync(marker); } catch {}
  return report;
}
