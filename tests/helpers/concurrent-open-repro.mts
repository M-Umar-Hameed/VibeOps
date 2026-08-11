// Child for concurrent-open repro: opens PGlite in argv[2], migrates, prints "ready",
// then keeps the connection open until killed. Simulates the server holding the data dir.
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = process.argv[2];

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

// Insert a marker row so we can verify state later
await client.query("INSERT INTO projects (key, name) VALUES ('server', 'Server-owned')");

console.log("ready");

// Keep alive - simulates server holding connection
setInterval(() => {}, 10000);
