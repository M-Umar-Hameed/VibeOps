import { expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { writeBackup } from "../src/services/backup.js";
import {
  afterLocalExport, readBackupStatus, sameVolume, syncSnapshotOffsite, validateOffsiteDir,
} from "../src/services/offsite.js";
import { vibeopsHome } from "../src/runtime/home.js";
import { withSetting } from "./helpers/settings.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `vibeops-${p}-`));
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

test("unset: local export only, nothing offsite", async () => {
  const local = tmp("loc"), other = tmp("off");
  const r = await writeBackup(stamp(), undefined, local);
  expect(existsSync(r.path)).toBe(true);
  expect(r.offsite.skipped).toBe("unset");
  expect(readdirSync(other)).toEqual([]);
});

test("set: export copied, no tmp left, status ok", async () => {
  const local = tmp("loc"), off = tmp("off");
  await withSetting("backup.offsiteDir", off, async () => {
    const r = await writeBackup(stamp(), undefined, local);
    const copy = join(off, "exports", basename(r.path));
    expect(readFileSync(copy, "utf-8")).toBe(readFileSync(r.path, "utf-8"));
    expect(readdirSync(join(off, "exports")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const s = readBackupStatus();
    expect(s.lastOffsiteExport?.ok).toBe(true);
    expect(s.lastLocalExport?.path).toBe(r.path);
  });
});

test("offsite path is a file: primary succeeds, error recorded", async () => {
  const local = tmp("loc"), f = join(tmp("f"), "afile");
  writeFileSync(f, "x");
  await withSetting("backup.offsiteDir", f, async () => {
    const r = await writeBackup(stamp(), undefined, local);
    expect(existsSync(r.path)).toBe(true);
    expect(r.offsite.ok).toBe(false);
    const s = readBackupStatus();
    expect(s.lastOffsiteExport?.ok).toBe(false);
    expect(s.lastOffsiteExport?.error).toBeTruthy();
  });
});

const freeDrive = process.platform === "win32" ? [..."ZYXWVUTSRQ"].find((l) => !existsSync(`${l}:\\`)) : undefined;
test.skipIf(!freeDrive)("missing drive: primary succeeds, error recorded", async () => {
  const local = tmp("loc");
  await withSetting("backup.offsiteDir", `${freeDrive}:\\vibeops-backup`, async () => {
    const r = await writeBackup(stamp(), undefined, local);
    expect(existsSync(r.path)).toBe(true);
    expect(r.offsite.ok).toBe(false);
    expect(readBackupStatus().lastOffsiteExport?.error).toBeTruthy();
  });
});

test("value inside .vibeops or relative is rejected; empty is off", async () => {
  const inside = join(vibeopsHome(), ".vibeops", "x");
  expect(validateOffsiteDir(inside).error).toBeTruthy();
  expect(validateOffsiteDir("backups").error).toBeTruthy();
  expect(validateOffsiteDir("")).toEqual({ dir: null });
  const r = await afterLocalExport(join(tmp("loc"), "export-x.json"));
  expect(r.skipped).toBe("unset");
  await withSetting("backup.offsiteDir", inside, async () => {
    const w = await writeBackup(stamp(), undefined, tmp("loc"));
    expect(w.offsite.ok).toBe(false);
    expect(readBackupStatus().lastOffsiteExport?.error).toContain("inside");
  });
});

test("sameVolume compares drive letters", () => {
  expect(sameVolume("C:\\a", "c:\\b")).toBe(true);
  expect(sameVolume("C:\\a", "H:\\b")).toBe(false);
  expect(sameVolume("/a", "C:\\b")).toBe(false);
});

test("snapshot sync: once, newest 3, no partial, single flight", async () => {
  const root = tmp("snap"), off = tmp("off");
  const data = join(root, "data");
  const mk = (i: number) => {
    const d = join(root, `data.good-2026-01-0${i}T00-00-00-000Z`);
    mkdirSync(d);
    writeFileSync(join(d, "f.txt"), String(i));
    return basename(d);
  };
  await withSetting("backup.offsiteDir", off, async () => {
    const snaps = join(off, "snapshots");
    const n1 = mk(1);
    expect((await syncSnapshotOffsite(data)).copied).toBe(true);
    expect(existsSync(join(snaps, n1, "f.txt"))).toBe(true);
    expect((await syncSnapshotOffsite(data)).skipped).toBe("already copied");
    const names = [n1];
    for (const i of [2, 3, 4]) { names.push(mk(i)); await syncSnapshotOffsite(data); }
    expect(readdirSync(snaps).sort()).toEqual(names.slice(1));
    mk(5);
    const [a, b] = await Promise.all([syncSnapshotOffsite(data), syncSnapshotOffsite(data)]);
    expect(a).toBe(b);
    expect(a.copied).toBe(true);
    expect(readdirSync(snaps).filter((f) => f.endsWith(".partial"))).toEqual([]);
    expect(readBackupStatus().lastOffsiteSnapshot?.ok).toBe(true);
  });
});

test("snapshot failure is recorded, not thrown", async () => {
  const root = tmp("snap"), f = join(tmp("f"), "afile");
  writeFileSync(f, "x");
  const d = join(root, "data.good-2026-02-01T00-00-00-000Z");
  mkdirSync(d);
  await withSetting("backup.offsiteDir", f, async () => {
    const r = await syncSnapshotOffsite(join(root, "data"));
    expect(r.error).toBeTruthy();
    expect(readBackupStatus().lastOffsiteSnapshot?.ok).toBe(false);
  });
});
