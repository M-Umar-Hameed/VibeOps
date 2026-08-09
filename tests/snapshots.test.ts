import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { snapshotGood, pruneSnapshots, latestGoodSnapshot } from "../src/db/snapshots.js";

test("snapshotGood copies, keeps last N, latestGoodSnapshot returns newest", () => {
  const root = mkdtempSync(join(tmpdir(), "vibeops-snap-"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "marker"), "x");

  const stamps = ["2026-01-01T00-00-00-000Z", "2026-01-02T00-00-00-000Z",
    "2026-01-03T00-00-00-000Z", "2026-01-04T00-00-00-000Z", "2026-01-05T00-00-00-000Z"];
  for (const ts of stamps) snapshotGood(dataDir, ts, 3);

  const snaps = readdirSync(root).filter((f) => f.startsWith(`${basename(dataDir)}.good-`)).sort();
  expect(snaps.length).toBe(3);                              // kept last 3
  expect(snaps).toEqual([
    "data.good-2026-01-03T00-00-00-000Z",
    "data.good-2026-01-04T00-00-00-000Z",
    "data.good-2026-01-05T00-00-00-000Z",
  ]);
  expect(latestGoodSnapshot(dataDir)).toBe(join(root, "data.good-2026-01-05T00-00-00-000Z"));

  rmSync(root, { recursive: true, force: true });
});

test("latestGoodSnapshot returns null when none exist", () => {
  const root = mkdtempSync(join(tmpdir(), "vibeops-snap-none-"));
  expect(latestGoodSnapshot(join(root, "data"))).toBeNull();
  rmSync(root, { recursive: true, force: true });
});
