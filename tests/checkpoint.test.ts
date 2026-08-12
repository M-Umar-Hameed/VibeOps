import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("CHECKPOINT is a valid cheap op and checkpointed rows survive a clean reopen", { timeout: 60_000 }, async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const dir = mkdtempSync(join(tmpdir(), "vibeops-ckpt-"));
  let client = new PGlite(dir, { extensions: { vector } });
  await client.exec("CREATE EXTENSION IF NOT EXISTS vector");
  const d: any = drizzle(client as never);
  await migrate(d, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  await client.query("insert into projects (key, name) values ('p','P')");
  await client.exec("CHECKPOINT");
  await client.close();

  client = new PGlite(dir, { extensions: { vector } });
  const r = await client.query("select count(*)::int as n from projects");
  expect((r.rows as { n: number }[])[0].n).toBe(1);
  await client.close();
  rmSync(dir, { recursive: true, force: true });
});

test("checkpointEmbedded no-ops (no throw) outside embedded mode", async () => {
  const { checkpointEmbedded } = await import("../src/db/client.js");
  await expect(checkpointEmbedded()).resolves.toBeUndefined();
});
