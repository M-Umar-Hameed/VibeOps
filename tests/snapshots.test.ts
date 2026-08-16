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

import { shouldSnapshot, SNAPSHOT_MAX_AGE_MS } from "../src/db/snapshots.js";
import { utimesSync } from "node:fs";

test("shouldSnapshot: unclean shutdown always takes", () => {
  const root = mkdtempSync(join(tmpdir(), "vibeops-dec-unclean-"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  snapshotGood(dataDir, "2026-01-01T00-00-00-000Z", 3); // fresh snapshot present
  const { take, reason } = shouldSnapshot(dataDir, false, Date.now());
  expect(take).toBe(true);
  expect(reason).toContain("unclean");
  rmSync(root, { recursive: true, force: true });
});

test("shouldSnapshot: clean + no snapshot takes", () => {
  const root = mkdtempSync(join(tmpdir(), "vibeops-dec-none-"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  expect(shouldSnapshot(dataDir, true, Date.now()).take).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test("shouldSnapshot: clean + fresh snapshot skips", () => {
  const root = mkdtempSync(join(tmpdir(), "vibeops-dec-fresh-"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  snapshotGood(dataDir, "2026-01-01T00-00-00-000Z", 3);
  expect(shouldSnapshot(dataDir, true, Date.now()).take).toBe(false);
  rmSync(root, { recursive: true, force: true });
});

// Mutation guard: a stale snapshot must refresh even on a clean shutdown. If the
// skip is made unconditional (age check ignored), take flips to false and this fails.
test("shouldSnapshot: clean + stale snapshot takes (age check)", () => {
  const root = mkdtempSync(join(tmpdir(), "vibeops-dec-stale-"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  const snap = snapshotGood(dataDir, "2026-01-01T00-00-00-000Z", 3);
  const old = new Date(Date.now() - SNAPSHOT_MAX_AGE_MS - 60_000);
  utimesSync(snap, old, old); // force mtime older than the max age
  const { take, reason } = shouldSnapshot(dataDir, true, Date.now());
  expect(take).toBe(true);
  expect(reason).toContain("stale");
  rmSync(root, { recursive: true, force: true });
});

