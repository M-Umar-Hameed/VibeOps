import { expect, test } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { allocateSlice } from "../src/runtime/slice.js";

// Snapshot the sidecar-created paths that matter: credentials.json content and
// data/ directory listing. If the sidecar writes to the real home, these will
// change. Mtime-based full-tree snapshot is too fragile (background indexers,
// antivirus, etc. touch timestamps).
function sidecarSnapshot(vibeops: string): { creds: string | null; dataFiles: string[] } {
  const credsPath = join(vibeops, "credentials.json");
  let creds: string | null = null;
  try { creds = readFileSync(credsPath, "utf8"); } catch { /* absent */ }

  const dataPath = join(vibeops, "data");
  let dataFiles: string[] = [];
  try {
    const walk = (d: string, prefix: string): string[] => {
      const out: string[] = [];
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        const rel = prefix ? `${prefix}/${e}` : e;
        const st = statSync(p);
        if (st.isDirectory()) out.push(...walk(p, rel));
        else out.push(`${rel}:${st.size}`);
      }
      return out;
    };
    dataFiles = walk(dataPath, "").sort();
  } catch { /* absent */ }

  return { creds, dataFiles };
}

test("sidecar under a slice writes only under slice.home; real ~/.vibeops untouched", { timeout: 120_000 }, async () => {
  const realVibeops = join(homedir(), ".vibeops");
  const before = sidecarSnapshot(realVibeops);

  const home = mkdtempSync(join(tmpdir(), "slice-int-home-"));
  const slice = await allocateSlice({ ticketId: randomUUID(), home });
  slice.freePort(); // hand the reserved port to the sidecar to bind

  const env: Record<string, string> = { ...process.env as Record<string, string>, ...slice.env, EMBED_PROVIDER: "fake" };
  delete env.VITEST;        // let the sidecar run embedded PGlite under home
  delete env.DATABASE_URL;  // embedded requires no URL; the slice DB is for suite isolation, not this sidecar
  const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/api/server.ts"], { env, stdio: "ignore" });
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const res = await fetch(`http://127.0.0.1:${slice.port}/projects`);
        if (res.status === 401) { up = true; break; }
      } catch { /* not up yet */ }
    }
    expect(up).toBe(true);
    // Sidecar wrote to slice home
    expect(existsSync(join(home, ".vibeops", "credentials.json"))).toBe(true);
    expect(existsSync(join(home, ".vibeops", "data"))).toBe(true);
    // Real home's sidecar-created paths unchanged
    const after = sidecarSnapshot(realVibeops);
    expect(after.creds).toBe(before.creds);
    expect(after.dataFiles).toEqual(before.dataFiles);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    await slice.release();
    rmSync(home, { recursive: true, force: true });
  }
});
