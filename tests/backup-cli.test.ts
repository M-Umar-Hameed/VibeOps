import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function runCli(home: string, args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, VIBEOPS_HOME: home };
  delete env.DATABASE_URL;
  delete env.VITEST;
  return spawnSync(process.execPath, ["--import", "tsx", "src/db/backup-cli.ts", ...args], {
    cwd: root, env, encoding: "utf-8", timeout: 55_000,
  });
}

async function buildCluster(dataDir: string) {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  const client = new PGlite(dataDir, { extensions: { vector } });
  await client.exec("CREATE EXTENSION IF NOT EXISTS vector");
  await client.close();
}

async function corruptHome(): Promise<{ home: string; dataDir: string; snap: string }> {
  const home = mkdtempSync(join(tmpdir(), "vibeops-cli-"));
  const dataDir = join(home, ".vibeops", "data");
  mkdirSync(join(home, ".vibeops"), { recursive: true });
  await buildCluster(dataDir);
  const snap = `${dataDir}.good-2026-01-01T00-00-00-000Z`;
  cpSync(dataDir, snap, { recursive: true });
  writeFileSync(join(dataDir, "PG_VERSION"), "0");
  return { home, dataDir, snap };
}

test("backup on unopenable embedded DB prints reason + snapshot path, exits non-zero", async () => {
  const { home, dataDir, snap } = await corruptHome();
  const res = runCli(home, ["backup"]);
  expect(res.status).not.toBe(0);
  expect(res.stderr).toContain(dataDir);
  expect(res.stderr).toContain(snap);
}, 60_000);

test("restore on unopenable embedded DB prints reason + snapshot path, exits non-zero", async () => {
  const { home, dataDir, snap } = await corruptHome();
  const res = runCli(home, ["restore", "does-not-matter.json"]);
  expect(res.status).not.toBe(0);
  expect(res.stderr).toContain(dataDir);
  expect(res.stderr).toContain(snap);
}, 60_000);

test("backup on a healthy embedded DB still writes an export and exits 0", async () => {
  const home = mkdtempSync(join(tmpdir(), "vibeops-cli-ok-"));
  const res = runCli(home, ["backup"]);
  expect(res.status).toBe(0);
  const out = JSON.parse(res.stdout);
  expect(typeof out.path).toBe("string");
  expect(existsSync(out.path)).toBe(true);
  expect(out.counts).toBeTruthy();
  JSON.parse(readFileSync(out.path, "utf-8"));
}, 60_000);
