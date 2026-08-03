import type { ServerType } from "@hono/node-server";

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

// SIGINT/SIGTERM cover CLI/POSIX. stdin-EOF covers the Tauri sidecar on every OS
// (Windows cannot deliver SIGTERM to a child; a closed piped stdin is detectable
// everywhere). Only attach the stdin path in embedded mode.
export function installShutdown(
  server: ServerType, closeDb: () => Promise<void>, embedded: boolean,
): void {
  const shutdown = makeShutdown(server, closeDb);
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  if (embedded) {
    process.stdin.on("end", () => void shutdown("stdin-eof"));
    process.stdin.resume();
  }
}
