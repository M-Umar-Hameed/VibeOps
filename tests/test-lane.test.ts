import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";

// A definitely-closed port: reserve an ephemeral one, then release it.
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const p = a && typeof a === "object" ? a.port : 0;
      s.close(() => resolve(p));
    });
  });
}

test("runner fails fast with an actionable line when Postgres down and fallback disabled", async () => {
  const port = await closedPort();
  const env = { ...process.env };
  delete env.VIBEOPS_TEST_EMBEDDED;
  env.VIBEOPS_TEST_PROBE_PORT = String(port);
  const t0 = Date.now();
  const r = spawnSync("node", ["scripts/test-lane.mjs"], { env, encoding: "utf8" });
  const ms = Date.now() - t0;
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/VIBEOPS_TEST_EMBEDDED=1/);
  expect(r.stderr).toMatch(/db:up/);
  expect(ms).toBeLessThan(5000);
});
