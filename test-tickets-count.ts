import { db } from "./src/db/client.js";
import { tickets } from "./src/db/schema.js";

async function run() {
  const rows = await db.select().from(tickets);
  console.log("Total tickets:", rows.length);
  const titles = new Set(rows.map(r => r.title));
  console.log("Unique titles:", Array.from(titles).slice(0, 10));
}
run().catch(console.error);
