import { expect, test } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBootSnapshot } from "../src/db/client.js";
import { latestGoodSnapshot } from "../src/db/snapshots.js";
import { closeEmbedded } from "../src/db/lifecycle.js";

// Throwaway data dir passed directly instead of a throwaway VIBEOPS_HOME: same
// isolation intent, no global env mutation that could leak across the suite.
test("boot snapshot: skipped after clean shutdown, recreated after unclean", { timeout: 60_000 }, async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const dataDir = mkdtempSync(join(tmpdir(), "vibeops-boot-snap-"));
  const pidFile = join(dataDir, "postmaster.pid");

  // Boot 1: fresh dir, no snapshot -> takes.
  let clean = !existsSync(pidFile);            // true
  let client = new PGlite(dataDir);
  await client.exec("select 1");
  const r1 = await runBootSnapshot(client, dataDir, clean, Date.now());
  expect(r1.taken).toBe(true);
  const snap1 = latestGoodSnapshot(dataDir);
  expect(snap1).not.toBeNull();
  await closeEmbedded(client, dataDir);        // clean close removes pid

  // Boot 2: clean shutdown + fresh snapshot -> skipped, snapshot NOT recreated.
  clean = !existsSync(pidFile);                // true (pid removed)
  expect(clean).toBe(true);
  client = new PGlite(dataDir);
  await client.exec("select 1");
  const r2 = await runBootSnapshot(client, dataDir, clean, Date.now());
  expect(r2.taken).toBe(false);
  expect(latestGoodSnapshot(dataDir)).toBe(snap1); // same newest snapshot
  await closeEmbedded(client, dataDir);

  // Boot 3: plant a postmaster.pid (unclean) BEFORE reopening -> recreated.
  writeFileSync(pidFile, "999999\n");          // pid read before new PGlite rewrites it
  clean = !existsSync(pidFile);                // false
  expect(clean).toBe(false);
  client = new PGlite(dataDir);
  await client.exec("select 1");
  const r3 = await runBootSnapshot(client, dataDir, clean, Date.now());
  expect(r3.taken).toBe(true);
  await closeEmbedded(client, dataDir);

  rmSync(dataDir, { recursive: true, force: true });
});
