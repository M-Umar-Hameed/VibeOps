import type { ServerType } from "@hono/node-server";
import { fstatSync } from "node:fs";

// Single idempotent shutdown: stop accepting connections, checkpoint the DB by
// closing it, then exit 0. Exposed as a factory so it can be unit-tested without
// real signals.
export function makeShutdown(server: ServerType, closeDb: () => Promise<void>) {
  let closing = false;
  return async function shutdown(reason: string): Promise<void> {
    if (closing) return;
    closing = true;
    console.log(`shutting down (${reason}); checkpointing embedded database`);
    await new Promise<void>((r) => server.close(() => r()));
    try { await closeDb(); } catch (e) { console.error(`db close failed: ${(e as Error).message}`); }
    process.exit(0);
  };
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
  server: ServerType, closeDb: () => Promise<void>, embedded: boolean,
): void {
  const shutdown = makeShutdown(server, closeDb);
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  if (embedded && stdinIsPipe()) {
    process.stdin.on("end", () => void shutdown("stdin-eof"));
    process.stdin.resume();
  }
}
