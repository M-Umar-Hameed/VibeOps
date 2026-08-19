import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { PG_BASE, ensureTemplate } from "../src/runtime/slice.js";

// The :5433 Postgres is test-dedicated. Embedding/note rows accumulate across
// runs and degrade approximate hnsw recall until distance-0 self-matches start
// missing the top-k — the recurring "flake" in knowledge/e2e tests. One wipe
// per suite run keeps the vector index deterministic; per-file cleanup can't,
// because files run in parallel against the shared DB.
// Nothing else migrates this database. src/db/client.ts migrates only the
// embedded PGlite lane; with DATABASE_URL set it just wraps the connection, and
// ensureTemplate migrates the SLICE TEMPLATE, not this one. So this is the only
// place the shared test database is kept in step with drizzle/.
//
// Three cases, keyed off whether the schema and drizzle's own bookkeeping exist:
//   1. Empty DB (no actors): provision from scratch. migrate() also creates
//      drizzle.__drizzle_migrations, so every later run takes case 3.
//   2. Schema present, NO bookkeeping (database predates drizzle tracking): we
//      cannot know which migrations it has, so we can neither baseline nor
//      migrate safely — drizzle would replay 0000 and die on CREATE TYPE
//      actor_kind (42710). Fail loudly with the one-time rebuild command instead
//      of letting a later test fail with a confusing missing-column error.
//   3. Schema present, bookkeeping present: migrate() applies only migrations
//      newer than the latest recorded timestamp — an up-to-date DB is untouched
//      (no 0000 replay), a behind-but-tracked DB is brought current. This keeps
//      the shared DB from silently drifting behind the migration folder.
export async function ensureSharedSchema(sql: ReturnType<typeof postgres>): Promise<void> {
  const [provisioned] = await sql`SELECT to_regclass('public.actors') IS NOT NULL AS ok`;
  if (!provisioned?.ok) {
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
    return;
  }
  const [tracked] = await sql`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS ok`;
  if (!tracked?.ok) {
    throw new Error(
      "Test database is provisioned but has no drizzle migration history " +
        "(drizzle.__drizzle_migrations is missing), so it will silently drift behind " +
        "drizzle/. Rebuild it once: docker compose down -v && npm run db:up",
    );
  }
  await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
}

export default async function setup() {
  if (process.env.VIBEOPS_TEST_EMBEDDED === "1") {
    // Serial embedded lane: no Postgres. Migrate the throwaway PGlite once and
    // close it before workers open the same dir (serial => no concurrent open).
    const { PGlite } = await import("@electric-sql/pglite");
    const { vector } = await import("@electric-sql/pglite/vector");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const { resolveEmbeddedDataDir } = await import("../src/runtime/home.js");
    const { closeEmbedded } = await import("../src/db/lifecycle.js");
    const { mkdirSync } = await import("node:fs");
    const dir = resolveEmbeddedDataDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const client = new PGlite(dir, { extensions: { vector } });
    await client.exec("CREATE EXTENSION IF NOT EXISTS vector");
    await migrate(drizzle(client as never), { migrationsFolder: "drizzle" });
    await closeEmbedded(client, dir);
    return;
  }
  const url = process.env.DATABASE_URL ?? "postgres://tickets:tickets@localhost:5433/tickets";
  const sql = postgres(url, { max: 1 });
  try {
    await ensureSharedSchema(sql);
  } catch (e) {
    console.error("global-setup: migrating the test database failed:", (e as Error).message);
    throw e;
  }
  try {
    await sql`truncate table embeddings`;
    await sql`update notes set indexed = true where indexed = false`; // stop sweeps re-embedding stale bodies
    // withSetting restores on the happy path but cannot on a killed run, and a
    // leaked budget cap then rejects pipelines in every later suite with a 409.
    // Live case: a stranded ai.budget.perTicketTokens=1000 failed forge-api's
    // BUG1 test on master once token accounting started counting the prompt.
    // Any setting a test flips can strand here when its run is killed mid-way,
    // and the next suite then fails on state nobody wrote deliberately. Seen
    // twice: ai.budget.perTicketTokens=1000 rejecting pipelines with a 409, and
    // prompts.selfImprove=true making "selfImprove unset" fail its precondition.
    await sql`delete from settings where key like 'ai.budget%' or key = 'prompts.selfImprove'`;
    // ai_usage_logs only ever grows, and checkBudget's per-day query sums the whole
    // day across every ticket. Once token accounting started counting the prompt,
    // one day of suite runs reached 14.5M tokens over 22k rows and overran the
    // per-day test's deliberately-generous 10M ceiling, failing it 10 runs out of 10.
    await sql`truncate table ai_usage_logs`;
  } catch {
    // Schema may not exist yet on a fresh DB; tests that need it will create it.
  } finally {
    await sql.end();
  }

  // Build the slice test-template database once for the whole suite. Individual
  // test files calling allocateSlice() will see it already exists and skip the
  // expensive migration. This avoids timeouts when many files run in parallel.
  const admin = postgres(`${PG_BASE}/postgres`, { max: 1 });
  try {
    await ensureTemplate(admin);
  } finally {
    await admin.end();
  }
}
