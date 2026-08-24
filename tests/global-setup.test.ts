import { afterAll, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { PG_BASE } from "../src/runtime/slice.js";
import { ensureSharedSchema } from "./global-setup.js";

const admin = postgres(`${PG_BASE}/postgres`, { max: 1 });
const created: string[] = [];

async function freshDb(): Promise<ReturnType<typeof postgres>> {
  const name = `migdrift_${randomUUID().replace(/-/g, "")}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  created.push(name);
  return postgres(`${PG_BASE}/${name}`, { max: 1 });
}

afterAll(async () => {
  for (const name of created) {
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`);
  }
  await admin.end();
}, 60_000);

test("empty database is provisioned from scratch", async () => {
  const sql = await freshDb();
  try {
    await ensureSharedSchema(sql);
    const [a] = await sql`SELECT to_regclass('public.actors') IS NOT NULL AS ok`;
    const [m] = await sql`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS ok`;
    expect(a.ok).toBe(true);
    expect(m.ok).toBe(true);
  } finally {
    await sql.end();
  }
});

test("up-to-date database is untouched and does not replay 0000", async () => {
  const sql = await freshDb();
  try {
    await ensureSharedSchema(sql);
    const [{ count: before }] = await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    await ensureSharedSchema(sql); // must not throw; a 0000 replay would raise 42710
    const [{ count: after }] = await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    expect(after).toBe(before);
  } finally {
    await sql.end();
  }
});

test("a tracked database behind the migration folder is brought current", async () => {
  const sql = await freshDb();
  try {
    await ensureSharedSchema(sql); // full provision (tracked)
    // Simulate one migration behind by undoing the journal's LAST entry: drizzle
    // only replays migrations newer than the latest recorded row, so deleting
    // any earlier row proves nothing (that is how this test rotted when 0022
    // landed while it still hardcoded 0021). The columns to drop are read from
    // the migration's own SQL, so a future column-adding migration needs no
    // edit here; a migration that does more than ADD COLUMN needs a new fixture.
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf-8"));
    const last = journal.entries[journal.entries.length - 1];
    const migrationSql = readFileSync(`drizzle/${last.tag}.sql`, "utf-8");
    const added = [...migrationSql.matchAll(/ALTER TABLE "(\w+)" ADD COLUMN "(\w+)"/g)].map((m) => ({ table: m[1], column: m[2] }));
    expect(added.length).toBeGreaterThan(0);
    for (const { table, column } of added.slice().reverse()) {
      await sql`ALTER TABLE ${sql(table)} DROP COLUMN ${sql(column)}`;
    }
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE created_at = ${last.when}`;
    await ensureSharedSchema(sql);
    for (const { table, column } of added) {
      const [col] = await sql`SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = ${table} AND column_name = ${column}
      ) AS ok`;
      expect(col.ok).toBe(true);
    }
  } finally {
    await sql.end();
  }
});

test("a provisioned database with no migration history fails loudly", async () => {
  const sql = await freshDb();
  try {
    await ensureSharedSchema(sql);         // provision + bookkeeping
    await sql`DROP SCHEMA drizzle CASCADE`; // simulate a pre-bookkeeping legacy DB
    await expect(ensureSharedSchema(sql)).rejects.toThrow(/npm run db:rebuild/);
  } finally {
    await sql.end();
  }
});
