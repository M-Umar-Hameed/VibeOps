import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { vibeopsHome } from "../runtime/home.js";

// Check if the server is running BEFORE importing client.js (which opens PGlite).
// Concurrent access to the same data directory corrupts the database.
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 tests existence without killing
    return true;
  } catch {
    return false;
  }
}

function ensureServerStopped(): void {
  const dataDir = join(vibeopsHome(), ".vibeops", "data");
  const pidFile = join(dataDir, "postmaster.pid");
  if (!existsSync(pidFile)) return;
  let pid: number;
  try {
    const content = readFileSync(pidFile, "utf-8");
    pid = parseInt(content.split("\n")[0], 10);
    if (isNaN(pid)) return; // malformed, proceed
  } catch {
    return; // can't read, proceed
  }
  if (!isProcessRunning(pid)) return; // stale pid file, proceed
  console.error("ERROR: Another process (PID " + pid + ") holds the embedded database.");
  console.error("Stop the server before running backup/restore, or use the running server's API.");
  console.error("Concurrent access corrupts the database.");
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, arg] = process.argv.slice(2);
  ensureServerStopped();
  const { db, closeDb, embeddedDbError } = await import("./client.js");

  if (embeddedDbError) {
    console.error(embeddedDbError.message);
    process.exit(1);
  }

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
