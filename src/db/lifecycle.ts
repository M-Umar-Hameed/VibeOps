import { existsSync } from "node:fs";
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
  let client: PGlite;
  try {
    client = deps.makeClient(dataDir);
    await client.exec("CREATE EXTENSION IF NOT EXISTS vector");
  } catch (reason) {
    // No copy on failure (retired: it grew unbounded). Point the caller at the
    // latest rolling known-good snapshot instead, if one exists.
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
  const { rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  try { rmSync(join(dataDir, "postmaster.pid"), { force: true }); } catch { /* best effort */ }
}
