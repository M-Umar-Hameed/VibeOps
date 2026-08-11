// Child for concurrent-open test: opens PGlite in argv[2], migrates, writes in a loop,
// prints "ready" when connection open, continues writing until killed.
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = process.argv[2];
const id = process.argv[3] ?? "A";

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

console.log(`[${id}] ready`);

// Write in a loop
let counter = 0;
const interval = setInterval(async () => {
  try {
    const key = `${id}-${counter++}`;
    await client.query(`INSERT INTO projects (key, name) VALUES ($1, $2)`, [key, `Project ${key}`]);
    console.log(`[${id}] inserted ${key}`);
  } catch (e) {
    console.error(`[${id}] insert error:`, (e as Error).message);
  }
}, 100);

// Keep alive
process.on("SIGTERM", async () => {
  clearInterval(interval);
  await client.close();
  console.log(`[${id}] closed cleanly`);
  process.exit(0);
});
