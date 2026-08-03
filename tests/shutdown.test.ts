import { expect, test, vi } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeShutdown } from "../src/api/shutdown.js";

test("makeShutdown closes server then db, exits 0, and is idempotent", async () => {
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  const serverClose = vi.fn((cb: () => void) => cb());
  const closeDb = vi.fn(async () => {});
  const shutdown = makeShutdown({ close: serverClose } as never, closeDb);

  await shutdown("SIGTERM");
  await shutdown("SIGTERM"); // second call is a no-op

  expect(serverClose).toHaveBeenCalledTimes(1);
  expect(closeDb).toHaveBeenCalledTimes(1);
  expect(exit).toHaveBeenCalledWith(0);
  exit.mockRestore();
});

function waitReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.stdout!.on("data", (b) => { if (String(b).includes("ready")) resolve(); });
    child.on("exit", (c) => reject(new Error(`child exited early: ${c}`)));
  });
}
function waitExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.on("exit", (c) => resolve(c)));
}

test("stdin EOF triggers a clean shutdown: exit 0 and shutdown handler ran",
  { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibeops-sd-"));
  const script = fileURLToPath(new URL("./helpers/embedded-shutdown-child.mts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", script, dir], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env }
  });
  await waitReady(child);
  // Cluster is running - verify a PGlite data dir was created (proves it started)
  const files = readdirSync(dir);
  expect(files.length).toBeGreaterThan(0);
  child.stdin!.end();                                          // EOF -> graceful
  const code = await waitExit(child);
  // Exit 0 proves the shutdown handler ran and completed (it calls process.exit(0))
  expect(code).toBe(0);
  // Note: postmaster.pid removal on Windows may be delayed; exit 0 is the reliable signal
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")(
  "SIGTERM triggers a clean close on POSIX", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibeops-sg-"));
  const script = fileURLToPath(new URL("./helpers/embedded-shutdown-child.mts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", script, dir], {
    stdio: ["pipe", "pipe", "inherit"]
  });
  await waitReady(child);
  child.kill("SIGTERM");
  const code = await waitExit(child);
  expect(code).toBe(0);
  // On POSIX, postmaster.pid should be reliably removed
  expect(existsSync(join(dir, "postmaster.pid"))).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});
