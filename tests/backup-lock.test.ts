import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Spawns backup-cli.ts in a subprocess with VIBEOPS_HOME set to the given dir.
function runBackupCli(home: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const script = fileURLToPath(new URL("../src/db/backup-cli.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
      env: { ...process.env, VIBEOPS_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (b) => { stderr += String(b); });
    child.on("exit", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

test("backup CLI refuses when postmaster.pid holds a running PID", { timeout: 30_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "vibeops-lock-"));
  const dataDir = join(home, ".vibeops", "data");
  mkdirSync(dataDir, { recursive: true });
  // Write postmaster.pid with current process PID (simulates server holding the DB).
  writeFileSync(join(dataDir, "postmaster.pid"), `${process.pid}\n`, "utf-8");

  const { code, stderr } = await runBackupCli(home, ["backup"]);
  expect(code).toBe(1);
  expect(stderr).toContain("Another process");
  expect(stderr).toContain("Stop the server");

  rmSync(home, { recursive: true, force: true });
});

test("backup CLI proceeds when postmaster.pid has stale PID", { timeout: 30_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "vibeops-lock-"));
  const dataDir = join(home, ".vibeops", "data");
  mkdirSync(dataDir, { recursive: true });
  // Write postmaster.pid with a PID that does not exist (99999999).
  writeFileSync(join(dataDir, "postmaster.pid"), "99999999\n", "utf-8");

  const { code, stderr } = await runBackupCli(home, ["backup"]);
  // Will fail for other reasons (no DB), but NOT because of lock check.
  expect(stderr).not.toContain("Another process");
  // Code may be non-zero due to no DB; that's fine, we're testing lock bypass.

  rmSync(home, { recursive: true, force: true });
});

test("backup CLI writes a real export when no postmaster.pid exists", { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "vibeops-lock-"));
  const dataDir = join(home, ".vibeops", "data");
  mkdirSync(dataDir, { recursive: true });
  // No postmaster.pid: the CLI must bootstrap a fresh embedded DB and SUCCEED.
  // Asserting only that the lock message is absent would pass even if the guard
  // blocked every backup, so assert the export actually lands.
  const { code, stderr } = await runBackupCli(home, ["backup"]);
  expect(stderr).not.toContain("Another process");
  expect(code).toBe(0);
  const written = readdirSync(join(home, ".vibeops", "backups"));
  expect(written.some((f) => f.startsWith("export-") && f.endsWith(".json"))).toBe(true);

  rmSync(home, { recursive: true, force: true });
});
