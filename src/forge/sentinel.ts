import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { vibeopsHome } from "../runtime/home.js";

export type Snapshot = { path: string; hash: string; bytes: Buffer };

// Command-execution config that a later run's argv is read from. Cross-platform,
// under ~/.vibeops (VIBEOPS_HOME-overridable for tests). snapshotSensitive()
// skips any that don't exist, so always-including is harmless on dev/CI.
// server.mjs is the installed win32 payload from the original incident and stays
// win32-only. All are best-effort snapshots, never a hard requirement.
function defaultSensitivePaths(): string[] {
  const paths = [
    join(vibeopsHome(), ".vibeops", "relay.json"),
    join(vibeopsHome(), ".vibeops", "credentials.json"),
  ];
  if (process.platform === "win32") {
    paths.push(join(homedir(), "AppData", "Local", "VibeOps", "resources", "server", "server.mjs"));
  }
  return paths;
}

// forge.sensitivePaths (JSON string array of absolute paths) wins, incl. [] to
// disable; unset or malformed falls back to the platform default with a warning.
export function resolveSensitivePaths(setting: string | null): string[] {
  if (setting !== null) {
    try {
      const parsed: unknown = JSON.parse(setting);
      if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) return parsed;
      console.warn("forge.sensitivePaths: not a string array; using defaults");
    } catch {
      console.warn("forge.sensitivePaths: invalid JSON; using defaults");
    }
  }
  return defaultSensitivePaths();
}

function hashBytes(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

// Snapshot bytes+hash of every sensitive path that exists as a file. Missing
// paths are skipped (not an error). Best-effort: an unreadable path is skipped
// with a warning, never fatal — the sentinel must never break a run itself.
export function snapshotSensitive(paths: string[]): Snapshot[] {
  const snaps: Snapshot[] = [];
  for (const p of paths) {
    try {
      if (!existsSync(p) || !statSync(p).isFile()) continue;
      const bytes = readFileSync(p);
      snaps.push({ path: p, hash: hashBytes(bytes), bytes });
    } catch (e) {
      console.warn(`sentinel: cannot snapshot ${p}: ${String(e)}`);
    }
  }
  return snaps;
}

// Compare each snapshot to the file's current bytes; for every changed path,
// restore the snapshot bytes and record the tamper. Returns the restored paths
// (empty => nothing tampered).
export function detectAndRestore(snaps: Snapshot[]): string[] {
  const tampered: string[] = [];
  for (const s of snaps) {
    try {
      const now = existsSync(s.path) ? readFileSync(s.path) : Buffer.alloc(0);
      if (hashBytes(now) !== s.hash) {
        writeFileSync(s.path, s.bytes);
        tampered.push(s.path);
      }
    } catch (e) {
      console.warn(`sentinel: cannot check/restore ${s.path}: ${String(e)}`);
    }
  }
  return tampered;
}
