import net from "node:net";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOST = process.env.VIBEOPS_TEST_PROBE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.VIBEOPS_TEST_PROBE_PORT ?? 5433);
const EMBEDDED = process.env.VIBEOPS_TEST_EMBEDDED === "1";
const extra = process.argv.slice(2);
const win = process.platform === "win32";

function probe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(timeoutMs, () => done(false));
  });
}

// Every mkdtemp in the suite lands under one throwaway root that is removed
// when the run ends, so tests cannot litter the real TEMP (100 dirs / 480 MB
// were found there). Node reads TEMP/TMP on Windows and TMPDIR elsewhere.
const tmpRoot = mkdtempSync(join(tmpdir(), "vibeops-tests-"));
const tmpEnv = { TMPDIR: tmpRoot, TEMP: tmpRoot, TMP: tmpRoot };
function finish(status) {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* a leaked child may still hold a file; leave it */ }
  process.exit(status ?? 1);
}

const up = await probe(HOST, PORT, 1000);
if (up) {
  const r = spawnSync("npx", ["vitest", "run", ...extra], { stdio: "inherit", env: { ...process.env, ...tmpEnv }, shell: win });
  finish(r.status);
} else if (EMBEDDED) {
  const home = join(tmpRoot, "home");
  mkdirSync(home);
  process.stderr.write(`test Postgres :${PORT} down; running SERIAL EMBEDDED PGlite lane in ${home}\n`);
  const env = { ...process.env, ...tmpEnv, VIBEOPS_HOME: home, VIBEOPS_TEST_EMBEDDED: "1" };
  const r = spawnSync("npx", ["vitest", "run", "--no-file-parallelism", ...extra], { stdio: "inherit", env, shell: win });
  finish(r.status);
} else {
  process.stderr.write(`test Postgres :${PORT} is down. Run 'npm run db:up', or set VIBEOPS_TEST_EMBEDDED=1 to use the serial embedded PGlite lane.\n`);
  finish(2);
}
