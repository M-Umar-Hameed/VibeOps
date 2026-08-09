import { cpSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// Rolling known-good copies of the embedded data dir. Siblings named
// `<data>.good-<ts>`; keep the last N, prune older. Replaces the retired
// failure-time `.broken-<ts>` copy (which grew unbounded).
export const KEEP_SNAPSHOTS = 3;

function prefix(dataDir: string): string {
  return `${basename(dataDir)}.good-`;
}

export function snapshotGood(dataDir: string, ts: string, keep = KEEP_SNAPSHOTS): string {
  const path = `${dataDir}.good-${ts}`;
  cpSync(dataDir, path, { recursive: true });
  pruneSnapshots(dataDir, keep);
  return path;
}

export function pruneSnapshots(dataDir: string, keep: number): void {
  const dir = dirname(dataDir);
  const pref = prefix(dataDir);
  const snaps = readdirSync(dir).filter((f) => f.startsWith(pref)).sort();
  for (const f of snaps.slice(0, Math.max(0, snaps.length - keep))) {
    rmSync(join(dir, f), { recursive: true, force: true });
  }
}

// Newest `<data>.good-*` sibling, or null. Timestamps are lexicographically
// sortable (ISO with `:`/`.` -> `-`), so string sort == chronological.
export function latestGoodSnapshot(dataDir: string): string | null {
  const dir = dirname(dataDir);
  const pref = prefix(dataDir);
  try {
    const snaps = readdirSync(dir).filter((f) => f.startsWith(pref)).sort();
    return snaps.length ? join(dir, snaps[snaps.length - 1]) : null;
  } catch {
    return null;
  }
}
