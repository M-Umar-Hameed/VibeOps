import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { PG_BASE, ensureTemplate } from "../src/runtime/slice.js";

// The :5433 Postgres is test-dedicated. Embedding/note rows accumulate across
// runs and degrade approximate hnsw recall until distance-0 self-matches start
// missing the top-k — the recurring "flake" in knowledge/e2e tests. One wipe
// per suite run keeps the vector index deterministic; per-file cleanup can't,
// because files run in parallel against the shared DB.
export default async function setup() {
  const url = process.env.DATABASE_URL ?? "postgres://tickets:tickets@localhost:5433/tickets";
  const sql = postgres(url, { max: 1 });
  try {
    // Nothing else migrates this database. src/db/client.ts migrates only the
    // embedded PGlite lane; with DATABASE_URL set it just wraps the connection,
    // and ensureTemplate below migrates the SLICE TEMPLATE, not this one. On a
    // developer machine the database was migrated long ago so it never showed;
    // on a fresh CI database every test using the shared db import failed with
    // relation "actors" does not exist.
    //
    // Only provision an EMPTY database. Existing developer databases were set up
    // before drizzle kept its __drizzle_migrations bookkeeping here, so drizzle
    // considers nothing applied and replays 0000, which dies on CREATE TYPE
    // actor_kind (42710, already exists) and takes the whole suite down with it.
    // Nothing migrated those databases before this either, so skipping matches
    // the behaviour they already had.
    const [provisioned] = await sql`SELECT to_regclass('public.actors') IS NOT NULL AS ok`;
    if (!provisioned?.ok) {
      await sql`CREATE EXTENSION IF NOT EXISTS vector`;
      await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
    }
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
    await sql`delete from settings where key like 'ai.budget%'`;
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
