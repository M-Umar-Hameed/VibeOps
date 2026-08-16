import { cpSync, readdirSync, rmSync, statSync } from "node:fs";
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

export const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

// Boot-snapshot decision. Skip ONLY when the previous shutdown was clean AND the
// newest snapshot is younger than SNAPSHOT_MAX_AGE_MS. Every other case takes a
// snapshot: unclean shutdown, no snapshot yet, or a stale one.
export function shouldSnapshot(
  dataDir: string,
  prevShutdownClean: boolean,
  now: number,
): { take: boolean; reason: string } {
  if (!prevShutdownClean) return { take: true, reason: "unclean shutdown" };
  const latest = latestGoodSnapshot(dataDir);
  if (!latest) return { take: true, reason: "no snapshot yet" };
  const ageS = Math.round((now - statSync(latest).mtimeMs) / 1000);
  if (now - statSync(latest).mtimeMs >= SNAPSHOT_MAX_AGE_MS)
    return { take: true, reason: `snapshot stale (${ageS}s old)` };
  return { take: false, reason: `clean shutdown, snapshot ${ageS}s old` };
}
