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
    child.stderr!.on("data", (b) => console.error("child stderr:", String(b)));
    child.on("exit", (c) => { clearTimeout(timeout); reject(new Error(`child exited early: ${c}`)); });
  });
}

// Finding: PGlite 0.2.17 on Windows NodeFS survives hard kill via WAL replay.
// The ticket's "Aborted()" failure was likely a different version or config.
// Checkpointed state is durable; this test validates Task 2 premise.
test("hard kill WITH checkpoint: all rows survive via WAL replay", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibeops-hk-ck-"));
  const script = fileURLToPath(new URL("./helpers/hard-kill-repro.mts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", script, dir, "checkpoint"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdoutBuf = "";
  child.stdout!.on("data", (b) => { stdoutBuf += String(b); });
  await waitReady(child);
  expect(stdoutBuf).toContain("checkpoint done");

  // Hard kill
  if (process.platform === "win32") {
    const { execSync } = await import("node:child_process");
    execSync(`taskkill /F /PID ${child.pid}`);
  } else {
    child.kill("SIGKILL");
  }
  await new Promise((r) => child.on("exit", r));

  // Try to reopen - expect success with WAL replay
  const { openEmbedded } = await import("../src/db/lifecycle.js");
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  const { client } = await openEmbedded(dir, {
    makeClient: (d) => new PGlite(d, { extensions: { vector } }),
    now: () => "test",
  });
  const r = await client.query("SELECT key FROM projects ORDER BY key");
  const keys = (r.rows as { key: string }[]).map((x) => x.key);
  console.log("REOPEN SUCCESS - keys:", keys);
  // Both rows survive via WAL replay (confirmed on PGlite 0.2.17 NodeFS)
  expect(keys).toContain("pre");
  expect(keys).toContain("post");
  await client.close();
  rmSync(dir, { recursive: true, force: true });
});
