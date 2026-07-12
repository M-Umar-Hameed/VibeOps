import { expect, test } from "vitest";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("built sidecar payload boots embedded and serves 401", { timeout: 120_000 }, async () => {
  execSync("node scripts/build-server.mjs --out dist-server", { stdio: "inherit" });
  expect(existsSync("dist-server/server.mjs")).toBe(true);
  expect(existsSync("dist-server/node_modules/@electric-sql/pglite/package.json")).toBe(true);
  expect(existsSync("dist-server/drizzle")).toBe(true);

  const home = mkdtempSync(join(tmpdir(), "vibeops-home-"));
  const env = { ...process.env, PORT: "18787", VIBEOPS_MIGRATIONS_DIR: resolve("dist-server/drizzle"), HOME: home, USERPROFILE: home };
  delete (env as any).DATABASE_URL;
  delete (env as any).VITEST;
  const child = spawn(process.execPath, [resolve("dist-server/server.mjs")], { env, stdio: "pipe" });
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch("http://127.0.0.1:18787/projects");
        if (res.status === 401) { up = true; break; }
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(up).toBe(true);
    expect(existsSync(join(home, ".vibeops", "credentials.json"))).toBe(true);
    expect(existsSync(join(home, ".vibeops", "vault", "README.md"))).toBe(true);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    rmSync(home, { recursive: true, force: true });
  }
});
