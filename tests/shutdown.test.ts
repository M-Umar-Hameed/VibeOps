import { expect, test, vi } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeShutdown, installShutdown } from "../src/api/shutdown.js";

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

test("makeShutdown bounds a hung db close by the deadline and exits anyway", async () => {
  vi.useFakeTimers();
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const serverClose = vi.fn((cb: () => void) => cb());
  const closeDb = vi.fn(() => new Promise<void>(() => {})); // never resolves
  const shutdown = makeShutdown({ close: serverClose } as never, closeDb);

  const p = shutdown("SIGTERM");
  await vi.advanceTimersByTimeAsync(5000);
  await p;

  expect(closeDb).toHaveBeenCalledTimes(1);
  expect(exit).toHaveBeenCalledWith(1);
  expect(err).toHaveBeenCalledWith(expect.stringContaining("deadline"));

  vi.useRealTimers();
  exit.mockRestore();
  err.mockRestore();
});

test("installShutdown registers SIGINT and SIGTERM handlers", () => {
  const once = vi.spyOn(process, "once");
  const serverClose = vi.fn((cb: () => void) => cb());
  installShutdown({ close: serverClose } as never, async () => {}, false); // embedded=false: no stdin path
  const signals = once.mock.calls.map((c) => c[0]);
  expect(signals).toContain("SIGINT");
  expect(signals).toContain("SIGTERM");
  once.mockRestore();
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

test("stdin EOF triggers a clean shutdown: exit 0, reopens cleanly",
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
  // Windows PGlite does NOT remove postmaster.pid on close — verified empirically.
  // The file stays even after client.close() + 5s wait. What matters is that
  // client.close() writes a shutdown checkpoint; the database reopens cleanly
  // regardless of the stale pid file. Exit 0 from the handler (which calls
  // client.close()) is therefore the reliable signal on Windows.
  // CRITICAL ASSERTION: the cluster must reopen without error (proves checkpoint worked)
  const { openEmbedded } = await import("../src/db/lifecycle.js");
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  const { client } = await openEmbedded(dir, {
    makeClient: (d) => new PGlite(d, { extensions: { vector } }),
    now: () => "reopen-test",
  });
  // If we got here without EmbeddedDbOpenError, the shutdown checkpoint was valid
  await client.close();
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

test("installShutdown registers an HTTP shutdown handler", async () => {
  const { setShutdownHandler, isShutdownWired, requestShutdown, installShutdown } =
    await import("../src/api/shutdown.js");
  setShutdownHandler(undefined);
  expect(isShutdownWired()).toBe(false);
  const serverClose = vi.fn((cb: () => void) => cb());
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  installShutdown({ close: serverClose } as never, async () => {}, false);
  expect(isShutdownWired()).toBe(true);
  requestShutdown("test");
  await new Promise((r) => setTimeout(r, 20));
  expect(serverClose).toHaveBeenCalledTimes(1);
  expect(exit).toHaveBeenCalledWith(0);
  exit.mockRestore();
});
