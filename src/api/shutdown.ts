import type { ServerType } from "@hono/node-server";
import { fstatSync } from "node:fs";

// Single idempotent shutdown: stop accepting connections, checkpoint the DB by
// closing it, then exit 0. Exposed as a factory so it can be unit-tested without
// real signals.
// A hung closeDb must never trap the process. Bound it: 5s (matches the
// sql.end timeout; a clean PGlite checkpoint is sub-second). Hit deadline or
// close error -> log, exit 1 anyway. Clean -> exit 0.
const CLOSE_DEADLINE_MS = 5000;

export function makeShutdown(server: ServerType, closeDb: () => Promise<void>, onBeforeClose?: () => Promise<void>) {
  let closing = false;
  return async function shutdown(reason: string): Promise<void> {
    if (closing) return;
    closing = true;
    console.log(`shutting down (${reason}); checkpointing embedded database`);
    await new Promise<void>((r) => server.close(() => r()));
    if (onBeforeClose) {
      try { await onBeforeClose(); }
      catch (e) { console.warn(`pre-close backup failed: ${(e as Error).message}`); }
    }
    let code = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((r) => {
      timer = setTimeout(() => r("timeout"), CLOSE_DEADLINE_MS);
    });
    try {
      const result = await Promise.race([closeDb().then(() => "closed" as const), deadline]);
      if (result === "timeout") {
        console.error(`db close exceeded ${CLOSE_DEADLINE_MS}ms deadline; exiting anyway`);
        code = 1;
      }
    } catch (e) {
      console.error(`db close failed: ${(e as Error).message}`);
      code = 1;
    } finally {
      clearTimeout(timer);
    }
    process.exit(code);
  };
}

// HTTP-triggered shutdown: the POST /system/shutdown route (admin-only) reaches
// the same graceful path signals/stdin-EOF use, but the route exists at import
// time while server+closeDb only exist after boot. installShutdown registers the
// live handler here; the route calls requestShutdown.
let shutdownHandler: ((reason: string) => Promise<void>) | undefined;
export function setShutdownHandler(fn: ((reason: string) => Promise<void>) | undefined): void {
  shutdownHandler = fn;
}
// False when no server is wired (unit tests, pre-boot) so the route answers 503.
export function isShutdownWired(): boolean {
  return shutdownHandler !== undefined;
}
export function requestShutdown(reason: string): void {
  void shutdownHandler?.(reason);
}

// Returns true if stdin is a real pipe (from Tauri), false if /dev/null or NUL
// (when spawned with stdio: "ignore" or no stdin). /dev/null is a character device;
// a pipe is not.
function stdinIsPipe(): boolean {
  try {
    return !fstatSync(0).isCharacterDevice();
  } catch {
    return false;
  }
}

// SIGINT/SIGTERM cover CLI/POSIX. stdin-EOF covers the Tauri sidecar on every OS
// (Windows cannot deliver SIGTERM to a child; a closed piped stdin is detectable
// everywhere). Only attach the stdin path in embedded mode AND when stdin is a
// real pipe (not /dev/null from stdio: "ignore").
export function installShutdown(
  server: ServerType, closeDb: () => Promise<void>, embedded: boolean, onBeforeClose?: () => Promise<void>,
): void {
  const shutdown = makeShutdown(server, closeDb, onBeforeClose);
  setShutdownHandler(shutdown);
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  if (embedded && stdinIsPipe()) {
    process.stdin.on("end", () => void shutdown("stdin-eof"));
    process.stdin.resume();
  }
}
