import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

async function freshDb() {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite({ extensions: { vector } });
  await client.exec("CREATE EXTENSION IF NOT EXISTS vector");
  const d: any = drizzle(client as never, { schema: (await import("../src/db/schema.js")) });
  await migrate(d, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  return { d, client };
}

test("reportAndClearRecovery diffs live vs newest export, reports discard, clears marker", async () => {
  const home = mkdtempSync(join(tmpdir(), "vibeops-rec-"));
  process.env.VIBEOPS_HOME = home;
  try {
    const backups = join(home, ".vibeops", "backups");
    mkdirSync(backups, { recursive: true });
    // Export captured 3 tickets; live DB (post-reset) has 1 -> discard of 2.
    const dump = { projects: [], actors: [], tickets: [{}, {}, {}], notes: [], comments: [], events: [], settings: [] };
    writeFileSync(join(backups, "export-2026-08-12T00-00-00-000Z.json"), JSON.stringify(dump));

    const { d, client } = await freshDb();
    const { projects } = await import("../src/db/schema.js");
    const [p] = await d.insert(projects).values({ key: "inbox", name: "Inbox" }).returning();
    const { tickets } = await import("../src/db/schema.js");
    await d.insert(tickets).values({ projectId: p.id, title: "t1" });

    const { markRecoveryPending, reportAndClearRecovery, recoveryMarkerPath } = await import("../src/db/recovery.js");
    markRecoveryPending("test", "2026-08-12T00-00-00-000Z");
    const report = await reportAndClearRecovery(d);
    expect(report).toContain("tickets -2");
    expect(existsSync(recoveryMarkerPath())).toBe(false);

    // No marker -> no report on a normal boot.
    expect(await reportAndClearRecovery(d)).toBeNull();
    await client.close();
  } finally {
    delete process.env.VIBEOPS_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});
