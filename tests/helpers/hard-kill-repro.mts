// Child for hard-kill repro: opens PGlite in argv[2], migrates, inserts marker rows,
// optionally checkpoints if argv[3] === "checkpoint", then prints "ready" and idles.
// Parent can SIGKILL this process to simulate unclean exit.
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = process.argv[2];
const doCheckpoint = process.argv[3] === "checkpoint";

mkdirSync(dir, { recursive: true });

const { PGlite } = await import("@electric-sql/pglite");
const { vector } = await import("@electric-sql/pglite/vector");
const { drizzle } = await import("drizzle-orm/pglite");
const { migrate } = await import("drizzle-orm/pglite/migrator");

const client = new PGlite(dir, { extensions: { vector } });
await client.exec("CREATE EXTENSION IF NOT EXISTS vector");
const d: any = drizzle(client as never);
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
await migrate(d, { migrationsFolder });

// Insert marker row (pre-checkpoint)
await client.query("INSERT INTO projects (key, name) VALUES ('pre', 'Pre-checkpoint')");

if (doCheckpoint) {
  await client.exec("CHECKPOINT");
  console.log("checkpoint done");
}

// Insert post-checkpoint row
await client.query("INSERT INTO projects (key, name) VALUES ('post', 'Post-checkpoint')");

console.log("ready");

// Keep alive
setInterval(() => {}, 10000);
