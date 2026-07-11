import { db } from "./src/db/client.js";
import { tickets } from "./src/db/schema.js";

async function run() {
  const rows = await db.select().from(tickets).limit(2);
  console.log(rows);
}
run().catch(console.error);
