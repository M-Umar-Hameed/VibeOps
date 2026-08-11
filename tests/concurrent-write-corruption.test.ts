import { expect, test } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function waitReady(child: ChildProcess, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timeout waiting for ${id}`)), 30000);
    child.stdout!.on("data", (b) => {
      const out = String(b);
      console.log(`STDOUT[${id}]:`, out.trim());
      if (out.includes("ready")) { clearTimeout(timeout); resolve(); }
    });
    child.stderr!.on("data", (b) => console.error(`STDERR[${id}]:`, String(b).trim()));
    child.on("exit", (c) => { clearTimeout(timeout); reject(new Error(`${id} exited early: ${c}`)); });
  });
}

// Test concurrent WRITERS: two processes both writing to the same data dir.
// This simulates what happens if backup CLI and server both write.
// Expected: either lock prevents it OR corruption on reopen.
test("concurrent writers: two PGlite instances writing to same dir", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibeops-cw-"));
  const script = fileURLToPath(new URL("./helpers/concurrent-open-writer.mts", import.meta.url));

  // First writer
  const writerA = spawn(process.execPath, ["--import", "tsx", script, dir, "A"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  await waitReady(writerA, "A");

  // Wait a bit for writes
  await new Promise((r) => setTimeout(r, 500));

  // Second writer
  const writerB = spawn(process.execPath, ["--import", "tsx", script, dir, "B"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let bExited = false;
  let bExitCode: number | null = null;
  writerB.on("exit", (code) => { bExited = true; bExitCode = code; });

  // Wait to see if B fails to open or succeeds
  await new Promise((r) => setTimeout(r, 2000));

  console.log("=== AFTER 2s OF CONCURRENT WRITING ===");
  console.log("writerB exited:", bExited, "code:", bExitCode);

  // Kill A with SIGKILL (hard kill)
  if (process.platform === "win32") {
    const { execSync } = await import("node:child_process");
    try { execSync(`taskkill /F /PID ${writerA.pid}`); } catch {}
  } else {
    writerA.kill("SIGKILL");
  }
  await new Promise((r) => writerA.on("exit", r));
  console.log("A: hard killed");

  // Kill B cleanly if still running
  if (!bExited) {
    writerB.kill();
    await new Promise((r) => writerB.on("exit", r));
    console.log("B: killed");
  }

  // Try to reopen
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  let reopenError: Error | null = null;
  let reopenKeys: string[] = [];

  try {
    const reopenClient = new PGlite(dir, { extensions: { vector } });
    await reopenClient.waitReady;
    const r = await reopenClient.query("SELECT key FROM projects ORDER BY key");
    reopenKeys = (r.rows as { key: string }[]).map((x) => x.key);
    console.log("REOPEN SUCCESS - keys count:", reopenKeys.length);
    console.log("REOPEN SUCCESS - keys:", reopenKeys.slice(0, 10), reopenKeys.length > 10 ? "..." : "");
    await reopenClient.close();
  } catch (e) {
    reopenError = e as Error;
    console.log("REOPEN FAILED:", reopenError.message);
  }

  rmSync(dir, { recursive: true, force: true });

  // Report findings
  console.log("=== CONCURRENT WRITE FINDING ===");
  console.log("B opened successfully while A was running:", !bExited || bExitCode === 0);
  console.log("reopenError:", reopenError?.message ?? "null");
});
