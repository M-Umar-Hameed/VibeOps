import { existsSync, unlinkSync } from "node:fs";
import net from "node:net";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
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

// Thrown when another process already holds the embedded data dir. The lock is
// OS-held (see acquireLock) and freed by the kernel on process death, so a holder
// is always live and is NEVER displaced - concurrent open corrupts PGlite.
// holderPid is known only for a same-process holder; cross-process it is null.
export class EmbeddedDbLockedError extends Error {
  constructor(readonly dataDir: string, readonly holderPid: number | null) {
    super(
      holderPid !== null
        ? `Embedded database at ${dataDir} is held by another process (PID ${holderPid}). ` +
          `Stop that process before opening the database; concurrent access corrupts the data directory.`
        : `Embedded database at ${dataDir} is held by another VibeOps process. ` +
          `Stop that process before opening the database; concurrent access corrupts the data directory.`,
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

const LEGACY_LOCK_FILE = ".vibeops-lock"; // pid file from earlier versions: ignored, removed once the OS lock is held
const held = new Map<string, net.Server>();

// Lock = exclusive local listener named after the data dir. The OS owns it and
// frees it when the process dies (even taskkill /F / SIGKILL): no stale state, no reclaim race.
export function lockAddress(dataDir: string): string {
  const abs = resolve(dataDir);
  const hash = createHash("sha256")
    .update(process.platform === "win32" ? abs.toLowerCase() : abs)
    .digest("hex").slice(0, 32);
  if (process.platform === "win32") return `\\\\.\\pipe\\vibeops-db-${hash}`;
  if (process.platform === "linux") return `\0vibeops-db-${hash}`; // abstract socket: no file, nothing stale
  return join(tmpdir(), `vibeops-db-${hash}.sock`);
}

function listenExclusive(addr: string): Promise<net.Server> {
  return new Promise((res, rej) => {
    const s = net.createServer((c) => c.destroy());
    s.once("error", rej);
    s.listen(addr, () => {
      s.off("error", rej);
      // An unhandled error on the held lock would crash the server; log it instead.
      s.on("error", (e) => console.error(`embedded db lock listener error: ${(e as Error).message}`));
      s.unref();
      res(s);
    });
  });
}

function inUse(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "EADDRINUSE" || (process.platform === "win32" && code === "EACCES");
}

// ponytail: socket-file platforms only (not win32/linux, not shipped). Unlinking a
// refused socket is a residual check-then-act race; upgrade path is flock via a native addon.
function staleSocketFile(addr: string): Promise<boolean> {
  if (process.platform === "win32" || process.platform === "linux") return Promise.resolve(false);
  return new Promise((res) => {
    const c = net.connect(addr);
    c.once("connect", () => { c.destroy(); res(false); });
    c.once("error", (e) => { const code = (e as NodeJS.ErrnoException).code; res(code === "ECONNREFUSED" || code === "ENOENT"); });
  });
}

async function acquireLock(dataDir: string): Promise<void> {
  const addr = lockAddress(dataDir);
  if (held.has(addr)) throw new EmbeddedDbLockedError(dataDir, process.pid);
  let server: net.Server;
  try {
    server = await listenExclusive(addr);
  } catch (e) {
    if (!inUse(e)) throw e;
    if (!(await staleSocketFile(addr))) throw new EmbeddedDbLockedError(dataDir, null);
    try { unlinkSync(addr); } catch { /* already gone */ }
    try { server = await listenExclusive(addr); }
    catch (e2) { if (inUse(e2)) throw new EmbeddedDbLockedError(dataDir, null); throw e2; }
  }
  held.set(addr, server);
  try { unlinkSync(join(dataDir, LEGACY_LOCK_FILE)); } catch { /* absent */ }
}

function releaseLock(dataDir: string): void {
  const addr = lockAddress(dataDir);
  held.get(addr)?.close();
  held.delete(addr);
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
  await acquireLock(dataDir); // held for the whole open, fresh dir included
  let client: PGlite;
  try {
    client = deps.makeClient(dataDir);
    await client.exec("CREATE EXTENSION IF NOT EXISTS vector");
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
  // PGlite.close() throws "PGlite is closed" on a second call, and closeDb is
  // reached twice on some shutdown paths -- guard here so every caller is
  // idempotent rather than each one remembering to check.
  if (!client.closed) await client.close();
  try { unlinkSync(join(dataDir, "postmaster.pid")); } catch { /* best effort */ }
  releaseLock(dataDir);
}
