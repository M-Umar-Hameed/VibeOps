import { db } from "./src/db/client.js";
import { sql } from "drizzle-orm";

async function run() {
  const res = await db.execute(sql`
    SELECT id, source_kind, source_ref, content
    FROM embeddings
    LIMIT 1
  `);
  const rows = res.rows || res;
  console.log("DB Row:", rows[0]);
}
run().catch(console.error);
