import { join } from "node:path";
import { vibeopsHome } from "../runtime/home.js";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

// Driver seam: DATABASE_URL -> postgres-js; vitest -> postgres-js fallback (the
// suite stays on real Postgres); otherwise embedded PGlite in ~/.vibeops/data.
const url = process.env.DATABASE_URL;
export const isEmbedded = !url && !process.env.VITEST;

// postgres-js connects lazily, so creating it unconditionally is harmless in
// embedded mode (no runtime code path uses `sql` there after this slice).
export const sql = postgres(url ?? "postgres://tickets:tickets@localhost:5433/tickets");

export let db!: ReturnType<typeof drizzlePg<typeof schema>>;
export let embeddedDbError: import("./lifecycle.js").EmbeddedDbOpenError | null = null;
let embeddedClient: import("@electric-sql/pglite").PGlite | null = null;
let embeddedDataDir: string | null = null;

// Default close = end the postgres-js pool (non-embedded / test lanes).
let closeImpl: () => Promise<void> = async () => { await sql.end({ timeout: 5 }); };
export function closeDb(): Promise<void> { return closeImpl(); }

async function makeDb(): Promise<void> {
  if (!isEmbedded) { db = drizzlePg(sql, { schema }); return; }
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const { openEmbedded, EmbeddedDbOpenError, closeEmbedded } = await import("./lifecycle.js");
  // PGlite's mkdir is not recursive; create the data dir (and ~/.vibeops) first.
  const dataDir = join(vibeopsHome(), ".vibeops", "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  let client;
  try {
    ({ client } = await openEmbedded(dataDir, {
      makeClient: (dir) => new PGlite(dir, { extensions: { vector } }),
      now: () => new Date().toISOString().replace(/[:.]/g, "-"),
    }));
  } catch (e) {
    // Corrupt cluster: do NOT crash the sidecar. Record it; server.ts serves a
    // degraded diagnostic so the failure reaches the user, not just stderr.
    if (e instanceof EmbeddedDbOpenError) {
      embeddedDbError = e;
      const { markRecoveryPending } = await import("./recovery.js");
      markRecoveryPending(e.message, new Date().toISOString().replace(/[:.]/g, "-"));
      return;
    }
    throw e;
  }
  embeddedClient = client;
  embeddedDataDir = dataDir;
  closeImpl = () => closeEmbedded(client, dataDir);
  const d = drizzlePglite(client as never, { schema });
  // The import.meta fallback only resolves in the source tree; the bundled payload
  // (server.mjs in resources/) MUST set VIBEOPS_MIGRATIONS_DIR (the launcher does).
  const migrationsDir = process.env.VIBEOPS_MIGRATIONS_DIR
    ?? fileURLToPath(new URL("../../drizzle", import.meta.url));
  await migrate(d as never, { migrationsFolder: migrationsDir });
  db = d as never;
}

// Rolling known-good snapshot of the embedded data dir. Called by the server at
// boot only (NOT from makeDb, or every CLI import would copy ~450MB). Checkpoints
// first so the on-disk copy is consistent while the cluster is still quiescent.
// Note: snapshot fires every embedded boot, keep 3; upgrade to daily/dirty-check if boot frequency makes 450MB copies costly.
export async function snapshotKnownGood(): Promise<string | null> {
  if (!embeddedClient || !embeddedDataDir) return null;
  const { snapshotGood } = await import("./snapshots.js");
  await embeddedClient.exec("CHECKPOINT");
  return snapshotGood(embeddedDataDir, new Date().toISOString().replace(/[:.]/g, "-"));
}

// Periodic CHECKPOINT reduces WAL replay time after an unclean exit. PGlite
// 0.2.17 NodeFS does replay correctly (all committed txns survive), but replay
// cost grows with WAL size. A tight interval keeps startup fast. Sub-second at
// standalone scale; no-op unless embedded (embeddedClient is null elsewhere).
export async function checkpointEmbedded(): Promise<void> {
  if (!embeddedClient) return;
  await embeddedClient.exec("CHECKPOINT");
}

await makeDb();
