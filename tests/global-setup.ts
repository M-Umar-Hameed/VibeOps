import postgres from "postgres";

// The :5433 Postgres is test-dedicated. Embedding/note rows accumulate across
// runs and degrade approximate hnsw recall until distance-0 self-matches start
// missing the top-k — the recurring "flake" in knowledge/e2e tests. One wipe
// per suite run keeps the vector index deterministic; per-file cleanup can't,
// because files run in parallel against the shared DB.
export default async function setup() {
  const url = process.env.DATABASE_URL ?? "postgres://tickets:tickets@localhost:5433/tickets";
  const sql = postgres(url, { max: 1 });
  try {
    await sql`truncate table embeddings`;
    await sql`update notes set indexed = true where indexed = false`; // stop sweeps re-embedding stale bodies
  } catch {
    // Schema may not exist yet on a fresh DB; tests that need it will create it.
  } finally {
    await sql.end();
  }
}
