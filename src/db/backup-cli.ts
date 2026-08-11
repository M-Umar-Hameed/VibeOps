import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, arg] = process.argv.slice(2);
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
