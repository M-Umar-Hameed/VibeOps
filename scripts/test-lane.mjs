import net from "node:net";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

const up = await probe(HOST, PORT, 1000);
if (up) {
  const r = spawnSync("npx", ["vitest", "run", ...extra], { stdio: "inherit", env: process.env, shell: win });
  process.exit(r.status ?? 1);
} else if (EMBEDDED) {
  const home = mkdtempSync(join(tmpdir(), "vibeops-embedded-"));
  process.stderr.write(`test Postgres :${PORT} down; running SERIAL EMBEDDED PGlite lane in ${home}\n`);
  const env = { ...process.env, VIBEOPS_HOME: home, VIBEOPS_TEST_EMBEDDED: "1" };
  const r = spawnSync("npx", ["vitest", "run", "--no-file-parallelism", ...extra], { stdio: "inherit", env, shell: win });
  rmSync(home, { recursive: true, force: true });
  process.exit(r.status ?? 1);
} else {
  process.stderr.write(`test Postgres :${PORT} is down. Run 'npm run db:up', or set VIBEOPS_TEST_EMBEDDED=1 to use the serial embedded PGlite lane.\n`);
  process.exit(2);
}
