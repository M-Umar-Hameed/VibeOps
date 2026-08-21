import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";

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

// The compose project name is pinned so a sandbox cannot spin up a rival stack
// that seizes host port 5433. That pin also makes `docker compose down -v`
// resolve to the SHARED stack from every worktree, so the remediation text must
// never hand that command out as the fix. Both halves are asserted together:
// dropping either one reintroduces a defect that cost hours to diagnose.
test("the shared test stack is pinned and no remediation tells you to destroy it", () => {
  const compose = readFileSync("docker-compose.yml", "utf-8");
  expect(compose).toMatch(/^name: tickets$/m);

  const setup = readFileSync("tests/global-setup.ts", "utf-8");
  expect(setup).toMatch(/npm run db:rebuild/);
  // ponytail: pins the exact regression wording rather than parsing intent - the
  // warning sentence names the command too, so a cleverer regex matched that.
  expect(setup).not.toMatch(/Rebuild it once: docker compose down -v/);
  expect(setup).toMatch(/Do NOT use/);

  const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
  // The rebuild must be scoped to the schema: the container is up (we just
  // queried it), so taking the stack down is both unnecessary and machine-wide.
  expect(pkg.scripts["db:rebuild"]).toMatch(/psql/);
  expect(pkg.scripts["db:rebuild"]).not.toMatch(/down -v/);
});
