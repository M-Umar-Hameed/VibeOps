import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

// Check if the server is running BEFORE importing client.js (which opens PGlite).
// Concurrent access to the same data directory corrupts the database.
async function ensureServerStopped(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    await fetch(`http://127.0.0.1:${port}/projects`, { signal: controller.signal });
    clearTimeout(timeout);
    // If fetch succeeded, server is running
    console.error("ERROR: Server is running. Stop it before running backup/restore.");
    console.error("Concurrent access to the embedded database causes corruption.");
    process.exit(1);
  } catch {
    // Fetch failed = server not running, proceed
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, arg] = process.argv.slice(2);
  await ensureServerStopped();
  const { db, closeDb } = await import("./client.js");
  const backup = await import("../services/backup.js");

  if (cmd === "backup") {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const { path, counts } = await backup.writeBackup(stamp, db);
    console.log(JSON.stringify({ path, counts }));
  } else if (cmd === "restore") {
    if (!arg) { console.error("usage: restore <export.json>"); process.exit(1); }
    const dump = JSON.parse(readFileSync(arg, "utf-8"));
    const counts = await backup.restoreDurable(db, dump);
    console.log(JSON.stringify({ restored: counts }));
  } else {
    console.error("usage: backup | restore <export.json>"); process.exit(1);
  }
  await closeDb();
  process.exit(0);
}
