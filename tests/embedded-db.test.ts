import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("migrations + vector round-trip work on PGlite", { timeout: 60_000 }, async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const dir = mkdtempSync(join(tmpdir(), "vibeops-pglite-"));
  const client = new PGlite(dir, { extensions: { vector } });
  await client.exec("CREATE EXTENSION IF NOT EXISTS vector");
  const d = drizzle(client as never);
  await migrate(d as never, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });

  const tables = await client.query(
    "select table_name from information_schema.tables where table_schema='public'");
  const names = (tables.rows as { table_name: string }[]).map((r) => r.table_name);
  for (const t of ["projects", "actors", "tickets", "comments", "events", "notes", "embeddings", "sync_links", "sync_comment_links"]) {
    expect(names).toContain(t);
  }

  // vector round-trip: insert an embedding row and cosine-query it back
  await client.query("insert into projects (key, name) values ('p','P')");
  const vec = `[${Array.from({ length: 1024 }, (_, i) => (i % 7) / 7).join(",")}]`;
  await client.query(
    `insert into embeddings (source_kind, source_ref, chunk_index, content, embedding, model, dim, content_hash)
     values ('vault','f.md',0,'hello', $1::vector,'fake',1024,'h')`, [vec]);
  const hit = await client.query(
    `select content, 1 - (embedding <=> $1::vector) as score from embeddings
     where dim = 1024 order by embedding <=> $1::vector limit 1`, [vec]);
  expect((hit.rows as { content: string; score: number }[])[0].content).toBe("hello");

  // The service uses Drizzle's tagged SQL rather than PGlite directly. Keep this
  // exact result shape covered: PGlite returns a QueryResult object, not an array.
  const { sql } = await import("drizzle-orm");
  const serviceHit = await d.execute(sql`
    select source_kind, source_ref, content,
           1 - (embedding <=> ${vec}::vector) as score
    from embeddings
    where dim = ${1024}
    order by embedding <=> ${vec}::vector
    limit ${1}`);
  expect((serviceHit as unknown as { rows: { content: string }[] }).rows[0].content).toBe("hello");

  await client.close();
  rmSync(dir, { recursive: true, force: true });
});
