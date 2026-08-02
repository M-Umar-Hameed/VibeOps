import { expect, test } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { allocateSlice } from "../src/runtime/slice.js";

// Read-only snapshot path -> size:mtime for the real ~/.vibeops, to prove the
// sidecar under a slice never touches it. Absent dir -> empty snapshot.
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      const p = join(d, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out[p] = `${st.size}:${st.mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

test("sidecar under a slice writes only under slice.home; real ~/.vibeops untouched", { timeout: 120_000 }, async () => {
  const realVibeops = join(homedir(), ".vibeops");
  const before = snapshot(realVibeops);

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
    expect(existsSync(join(home, ".vibeops", "credentials.json"))).toBe(true);
    expect(existsSync(join(home, ".vibeops", "data"))).toBe(true);
    expect(snapshot(realVibeops)).toEqual(before); // real home byte-identical
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    await slice.release();
    rmSync(home, { recursive: true, force: true });
  }
});
