import type { ServerType } from "@hono/node-server";
import { fstatSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { releasePollers } from "../browser/channel.js";

// Single idempotent shutdown: stop accepting connections, checkpoint the DB by
// closing it, then exit 0. Exposed as a factory so it can be unit-tested without
// real signals.
// A hung server close or closeDb must never trap the process. Bound both: 5s
// (matches the sql.end timeout; a clean PGlite checkpoint is sub-second). Hit
// deadline on server close -> log, proceed anyway. Hit deadline or close error
// on db close -> log, exit 1 anyway. Clean -> exit 0.
const CLOSE_DEADLINE_MS = 5000;

// Race p against CLOSE_DEADLINE_MS; resolves "timeout" on deadline, clears its timer either way.
async function withDeadline<T>(p: Promise<T>): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), CLOSE_DEADLINE_MS); });
  try { return await Promise.race([p, deadline]); }
  finally { clearTimeout(timer); }
}

export function makeShutdown(server: ServerType, closeDb: () => Promise<void>, onBeforeClose?: () => Promise<void>) {
  let closing = false;
  return async function shutdown(reason: string): Promise<void> {
    if (closing) return;
    closing = true;
    console.log(`shutting down (${reason}); checkpointing embedded database`);
    // Long-lived clients (UI /events SSE, Chrome extension, MCP streamable-HTTP GET)
    // never end their sockets, and server.close() only calls back once all have
    // ended. Stop accepting, then drop every connection, then wait (bounded).
    const closed = new Promise<void>((r) => server.close(() => r()));
    releasePollers();
    const http = server as Partial<Pick<HttpServer, "closeIdleConnections" | "closeAllConnections">>;
    http.closeIdleConnections?.();
    const grace = setTimeout(() => http.closeAllConnections?.(), 2000);
    if (await withDeadline(closed) === "timeout") {
      console.error(`server close exceeded ${CLOSE_DEADLINE_MS}ms deadline; checkpointing anyway`);
    }
    clearTimeout(grace);
    if (onBeforeClose) {
      try { await onBeforeClose(); }
      catch (e) { console.warn(`pre-close backup failed: ${(e as Error).message}`); }
    }
    let code = 0;
    try {
      const result = await withDeadline(closeDb().then(() => "closed" as const));
      if (result === "timeout") {
        console.error(`db close exceeded ${CLOSE_DEADLINE_MS}ms deadline; exiting anyway`);
        code = 1;
      }
    } catch (e) {
      console.error(`db close failed: ${(e as Error).message}`);
      code = 1;
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
