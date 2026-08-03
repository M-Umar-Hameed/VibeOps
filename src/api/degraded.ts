import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { EmbeddedDbOpenError } from "../db/lifecycle.js";

// When the embedded DB cannot be opened, keep the sidecar ALIVE and answer every
// route with a 503 describing the failure, the data dir, and the backup copy, so
// the frontend shows a real message instead of the app 404ing on a dead sidecar.
export function serveDegraded(err: EmbeddedDbOpenError, port: number): void {
  console.error(err.message);
  const app = new Hono();
  const payload = {
    error: "embedded_db_open_failed",
    dataDir: err.dataDir,
    backupPath: err.backupPath,
    message: err.message,
    recovery:
      "The database could not be opened, likely a corrupted write-ahead log after " +
      "an unclean shutdown. Your data files are intact and a backup copy was made. " +
      "PGlite cannot reset the WAL in-process; recover by running pg_resetwal against " +
      "the data directory in a Postgres 16 container. See docs/USER_GUIDE.md.",
  };
  app.all("*", (c) => c.json(payload, 503));
  serve({ fetch: app.fetch, port, hostname: "127.0.0.1", overrideGlobalObjects: false });
  console.error(`api on :${port} in RECOVERY mode (embedded db unavailable)`);
}
