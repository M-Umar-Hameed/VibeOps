import { expect, test } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function waitReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timeout waiting for ready")), 30000);
    child.stdout!.on("data", (b) => {
      if (String(b).includes("ready")) { clearTimeout(timeout); resolve(); }
    });
    child.on("exit", (c) => { clearTimeout(timeout); reject(new Error(`child exited early: ${c}`)); });
  });
}

// Test the concurrent-open hypothesis: running backup CLI (which opens its own
// PGlite instance via client.ts import) against the same data directory as a
// live server may cause corruption. PGlite is a single-writer embedded cluster.
test("concurrent open: second PGlite instance against same data dir", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibeops-co-"));
  const script = fileURLToPath(new URL("./helpers/concurrent-open-repro.mts", import.meta.url));

  // First process: simulates server holding the data dir
  const server = spawn(process.execPath, ["--import", "tsx", script, dir], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  await waitReady(server);
  console.log("SERVER: ready, holds data dir");

  // Second process: simulates backup CLI trying to open same dir
  const backup = spawn(process.execPath, ["--import", "tsx", script, dir], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let backupStdout = "";
  let backupStderr = "";
  backup.stdout!.on("data", (b) => { backupStdout += String(b); });
  backup.stderr!.on("data", (b) => { backupStderr += String(b); });

  // Wait for backup to finish (either error or success)
  const backupExit = await new Promise<number | null>((resolve) => {
    const timeout = setTimeout(() => {
      backup.kill();
      resolve(null);
    }, 15000);
    backup.on("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

  // Extract only last 500 chars of stderr to avoid minified code spam
  const stderrTail = backupStderr.slice(-500);
  console.log("BACKUP EXIT CODE:", backupExit);
  console.log("BACKUP STDOUT:", backupStdout.slice(0, 200));
  console.log("BACKUP STDERR (tail 500):", stderrTail);

  // Now kill server cleanly and try to reopen
  server.kill();
  await new Promise((r) => server.on("exit", r));
  console.log("SERVER: killed");

  // Try to reopen
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  let reopenError: Error | null = null;
  let reopenKeys: string[] = [];

  try {
    const reopenClient = new PGlite(dir, { extensions: { vector } });
    await reopenClient.waitReady;
    const r = await reopenClient.query("SELECT key FROM projects");
    reopenKeys = (r.rows as { key: string }[]).map((x) => x.key);
    console.log("REOPEN SUCCESS - keys:", reopenKeys);
    await reopenClient.close();
  } catch (e) {
    reopenError = e as Error;
    console.log("REOPEN FAILED:", reopenError.message);
  }

  rmSync(dir, { recursive: true, force: true });

  // Record findings
  console.log("=== CONCURRENT OPEN FINDING ===");
  console.log("backupExit:", backupExit);
  console.log("reopenError:", reopenError?.message ?? "null");
  console.log("reopenKeys:", reopenKeys);
});
