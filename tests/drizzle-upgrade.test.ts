import { expect, test } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FULL = fileURLToPath(new URL("../drizzle", import.meta.url));

async function open() {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const dir = mkdtempSync(join(tmpdir(), "vibeops-drizzle-up-"));
  const client = new PGlite(dir, { extensions: { vector } });
  await client.exec("CREATE EXTENSION IF NOT EXISTS vector");
  const d = drizzle(client as never);
  const run = (folder: string) => migrate(d as never, { migrationsFolder: folder });
  const count = async () =>
    ((await client.query("select count(*)::int as n from drizzle.__drizzle_migrations")).rows as { n: number }[])[0].n;
  const notesCols = async () =>
    ((await client.query(
      "select column_name from information_schema.columns where table_name='notes' and table_schema='public'",
    )).rows as { column_name: string }[]).map((r) => r.column_name);
  return { client, dir, run, count, notesCols };
}

test("fresh bootstrap applies every migration", { timeout: 60_000 }, async () => {
  const { client, dir, run, count, notesCols } = await open();
  try {
    await run(FULL);
    expect(await count()).toBe(28);
    const cols = await notesCols();
    expect(cols).toContain("status");
    expect(cols).toContain("confidence");
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("existing 27-migration database migrates to 28 and is idempotent", { timeout: 60_000 }, async () => {
  const { client, dir, run, count, notesCols } = await open();
  const old = mkdtempSync(join(tmpdir(), "vibeops-drizzle-old-"));
  try {
    mkdirSync(join(old, "meta"));
    for (const f of readdirSync(FULL)) {
      if (f.endsWith(".sql") && !f.startsWith("0027")) cpSync(join(FULL, f), join(old, f));
    }
    const journal = JSON.parse(readFileSync(join(FULL, "meta", "_journal.json"), "utf8"));
    journal.entries = journal.entries.slice(0, 27);
    writeFileSync(join(old, "meta", "_journal.json"), JSON.stringify(journal));

    await run(old);
    expect(await count()).toBe(27);
    expect(await notesCols()).not.toContain("confidence");

    await run(FULL);
    expect(await count()).toBe(28);
    const cols = await notesCols();
    expect(cols).toContain("status");
    expect(cols).toContain("confidence");

    await run(FULL);
    expect(await count()).toBe(28);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
  }
});
