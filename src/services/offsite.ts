import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { copyFile, cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { vibeopsHome } from "../runtime/home.js";
import { latestGoodSnapshot } from "../db/snapshots.js";
import { OFFSITE_TIERS, pruneBackups } from "./backup.js";
import { getSetting } from "./settings.js";

export type OffsiteExportResult = { ok: boolean; skipped?: string; error?: string; path?: string };
export type BackupStatus = {
  offsiteDir: string | null; offsiteError?: string; sameVolume: boolean;
  lastLocalExport: { at: string; path: string } | null;
  lastOffsiteExport: { at: string; ok: boolean; error?: string } | null;
  lastOffsiteSnapshot: { name: string; at: string; ok: boolean; error?: string } | null;
};
export const OFFSITE_SNAPSHOT_KEEP = 3;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const dataDirDefault = () => join(vibeopsHome(), ".vibeops", "data"); // string only, never opened

export function backupStatusPath(): string {
  return join(vibeopsHome(), ".vibeops", "backup-status.json");
}

const EMPTY: BackupStatus = {
  offsiteDir: null, sameVolume: false, lastLocalExport: null, lastOffsiteExport: null, lastOffsiteSnapshot: null,
};

export function readBackupStatus(): BackupStatus {
  try {
    return { ...EMPTY, ...JSON.parse(readFileSync(backupStatusPath(), "utf-8")) };
  } catch {
    return { ...EMPTY };
  }
}

function updateBackupStatus(patch: Partial<BackupStatus>): void {
  try {
    const p = backupStatusPath();
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...readBackupStatus(), ...patch }, null, 2));
    renameSync(tmp, p);
  } catch (e) {
    console.warn(`backup status write failed: ${msg(e)}`);
  }
}

export function validateOffsiteDir(value: string | null, home = vibeopsHome()): { dir: string | null; error?: string } {
  if (value === null || value.trim() === "") return { dir: null };
  const v = value.trim();
  const win = process.platform === "win32";
  const abs = win ? /^([a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(v) : isAbsolute(v);
  if (!abs) return { dir: null, error: "backup.offsiteDir must be an absolute path" };
  const norm = (s: string) => (win ? s.toLowerCase() : s);
  const base = resolve(home, ".vibeops");
  const target = resolve(v);
  const rel = relative(norm(base), norm(target));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return { dir: null, error: `backup.offsiteDir must not be inside ${base}` };
  }
  return { dir: target };
}

export function sameVolume(a: string, b: string): boolean {
  const da = /^([a-zA-Z]):/.exec(a)?.[1];
  const db = /^([a-zA-Z]):/.exec(b)?.[1];
  return !!da && !!db && da.toLowerCase() === db.toLowerCase();
}

async function resolveOffsite(): Promise<{ dir: string | null; error?: string; sameVolume: boolean }> {
  let r: { dir: string | null; error?: string };
  try {
    r = validateOffsiteDir(await getSetting("backup.offsiteDir"));
  } catch (e) {
    r = { dir: null, error: `cannot read backup.offsiteDir: ${msg(e)}` };
  }
  return { ...r, sameVolume: r.dir ? sameVolume(r.dir, dataDirDefault()) : false };
}

export async function getBackupStatus(): Promise<BackupStatus> {
  const o = await resolveOffsite();
  return { ...readBackupStatus(), offsiteDir: o.dir, offsiteError: o.error, sameVolume: o.sameVolume };
}

export async function afterLocalExport(localPath: string): Promise<OffsiteExportResult> {
  let tmp: string | undefined;
  try {
    updateBackupStatus({ lastLocalExport: { at: new Date().toISOString(), path: localPath } });
    const o = await resolveOffsite();
    updateBackupStatus({ offsiteDir: o.dir, offsiteError: o.error, sameVolume: o.sameVolume });
    if (!o.dir && !o.error) return { ok: true, skipped: "unset" };
    if (!o.dir) {
      updateBackupStatus({ lastOffsiteExport: { at: new Date().toISOString(), ok: false, error: o.error } });
      return { ok: false, error: o.error };
    }
    const dest = join(o.dir, "exports");
    await mkdir(dest, { recursive: true });
    const final = join(dest, basename(localPath));
    tmp = `${final}.tmp`;
    await copyFile(localPath, tmp);
    await rename(tmp, final);
    pruneBackups(dest, OFFSITE_TIERS);
    updateBackupStatus({ lastOffsiteExport: { at: new Date().toISOString(), ok: true } });
    return { ok: true, path: final };
  } catch (e) {
    if (tmp) await rm(tmp, { force: true }).catch(() => {});
    console.warn(`offsite export copy failed: ${msg(e)}`);
    updateBackupStatus({ lastOffsiteExport: { at: new Date().toISOString(), ok: false, error: msg(e) } });
    return { ok: false, error: msg(e) };
  }
}

type SnapResult = { copied: boolean; name?: string; skipped?: string; error?: string };
let inflight: Promise<SnapResult> | null = null;

export function syncSnapshotOffsite(dataDir: string = dataDirDefault()): Promise<SnapResult> {
  if (inflight) return inflight;
  inflight = doSync(dataDir).finally(() => { inflight = null; });
  return inflight;
}

async function doSync(dataDir: string): Promise<SnapResult> {
  let partial: string | undefined;
  let name = "";
  try {
    const o = await resolveOffsite();
    if (!o.dir) {
      if (!o.error) return { copied: false, skipped: "unset" };
      updateBackupStatus({ lastOffsiteSnapshot: { name, at: new Date().toISOString(), ok: false, error: o.error } });
      return { copied: false, error: o.error };
    }
    const latest = latestGoodSnapshot(dataDir);
    if (!latest) return { copied: false, skipped: "no snapshot" };
    name = basename(latest);
    const snaps = join(o.dir, "snapshots");
    const dest = join(snaps, name);
    const last = readBackupStatus().lastOffsiteSnapshot;
    if (last?.ok && last.name === name && existsSync(dest)) return { copied: false, skipped: "already copied", name };
    partial = `${dest}.partial`;
    await mkdir(snaps, { recursive: true });
    await rm(partial, { recursive: true, force: true });
    await cp(latest, partial, { recursive: true });
    await rm(dest, { recursive: true, force: true });
    await rename(partial, dest);
    const old = (await readdir(snaps))
      .filter((f) => f.startsWith("data.good-") && !f.endsWith(".partial"))
      .sort()
      .slice(0, -OFFSITE_SNAPSHOT_KEEP);
    for (const f of old) await rm(join(snaps, f), { recursive: true, force: true });
    updateBackupStatus({ lastOffsiteSnapshot: { name, at: new Date().toISOString(), ok: true } });
    return { copied: true, name };
  } catch (e) {
    if (partial) await rm(partial, { recursive: true, force: true }).catch(() => {});
    console.warn(`offsite snapshot copy failed: ${msg(e)}`);
    updateBackupStatus({ lastOffsiteSnapshot: { name, at: new Date().toISOString(), ok: false, error: msg(e) } });
    return { copied: false, error: msg(e) };
  }
}
