import { existsSync, openSync, closeSync, writeSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { latestGoodSnapshot } from "./snapshots.js";

// Thrown when the embedded cluster cannot be opened (typically a corrupt WAL
// after an unclean shutdown). Carries the data dir and the pre-recovery backup
// copy so the caller can surface both to the user.
export class EmbeddedDbOpenError extends Error {
  constructor(
    readonly dataDir: string,
    readonly backupPath: string | null,
    readonly reason: unknown,
  ) {
    super(
      `Embedded database at ${dataDir} could not be opened: ` +
      `${(reason as Error)?.message ?? String(reason)}. ` +
      (backupPath
        ? `The most recent known-good snapshot is at ${backupPath}.`
        : `No known-good snapshot is available.`),
    );
    this.name = "EmbeddedDbOpenError";
  }
}

const LOCK_FILE = ".vibeops-lock";

// Thrown when another process already holds the embedded data dir. A live holder
// is NEVER displaced - concurrent open corrupts PGlite (four production incidents).
export class EmbeddedDbLockedError extends Error {
  constructor(readonly dataDir: string, readonly holderPid: number | null) {
    super(
      holderPid !== null
        ? `Embedded database at ${dataDir} is held by another process (PID ${holderPid}). ` +
          `Stop that process before opening the database; concurrent access corrupts the data directory.`
        : `Embedded database at ${dataDir} has a lock file (${join(dataDir, LOCK_FILE)}) with an ` +
          `unreadable PID. If no vibeops process is running, delete that file and retry.`,
    );
    this.name = "EmbeddedDbLockedError";
  }
}

// Same-user desktop app: a live holder is always signalable, so a successful
// signal-0 means alive; any throw means the pid is not signalable (dead/reaped).
// ponytail: any-throw=dead is safe because the DB holder is always the same user;
// a cross-user deployment would need to treat EPERM as alive.
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readLockPid(lockPath: string): number | null {
  try {
    const pid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch { return null; }
}

// Atomic exclusive create. If the lock exists: a live OR unreadable holder ->
// refuse; a dead holder -> reclaim (stale from a hard kill, survivable) and retry.
// NEVER reclaims on age/time - a time-based steal is exactly how live DBs corrupt.
function acquireLock(dataDir: string): void {
  const lockPath = join(dataDir, LOCK_FILE);
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const holderPid = readLockPid(lockPath);
      if (holderPid === null || pidAlive(holderPid)) {
        throw new EmbeddedDbLockedError(dataDir, holderPid);
      }
      unlinkSync(lockPath); // dead pid: reclaim, then retry the exclusive create
      continue;
    }
    try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
    return;
  }
}

function releaseLock(dataDir: string): void {
  try { unlinkSync(join(dataDir, LOCK_FILE)); } catch { /* best effort */ }
}

export type OpenDeps = {
  makeClient: (dir: string) => PGlite; // () => new PGlite(dir, { extensions: { vector } })
  now: () => string;                   // timestamp for the backup dir name
};

// Opens the cluster and forces the engine to actually start (CREATE EXTENSION
// touches disk, so a corrupt WAL fails here rather than lazily later). On
// failure: back up the data dir, then throw EmbeddedDbOpenError. The original
// is left untouched — no delete, no reinit.
export async function openEmbedded(
  dataDir: string,
  deps: OpenDeps,
): Promise<{ client: PGlite }> {
  const isFresh = !existsSync(join(dataDir, "PG_VERSION"));
  acquireLock(dataDir);
  if (isFresh) {
    unlinkSync(join(dataDir, LOCK_FILE));
  }
  let client: PGlite;
  try {
    client = deps.makeClient(dataDir);
    await client.exec("CREATE EXTENSION IF NOT EXISTS vector");
    if (isFresh) {
      acquireLock(dataDir);
    }
  } catch (reason) {
    releaseLock(dataDir);
    const backupPath = existsSync(dataDir) ? latestGoodSnapshot(dataDir) : null;
    throw new EmbeddedDbOpenError(dataDir, backupPath, reason);
  }
  return { client };
}

// PGlite writes postmaster.pid on open and leaves it behind on close, so a cleanly
// stopped cluster still looks like a live holder on disk. Everything that closes an
// embedded cluster goes through here so the "clean close clears the pid, a hard kill
// leaves it" contract is true in one place rather than assumed in several.
export async function closeEmbedded(client: PGlite, dataDir: string): Promise<void> {
  await client.close();
  try { unlinkSync(join(dataDir, "postmaster.pid")); } catch { /* best effort */ }
  releaseLock(dataDir);
}
