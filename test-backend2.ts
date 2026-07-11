import { db } from "./src/db/client.js";
import { actors } from "./src/db/schema.js";

async function run() {
  const [actor] = await db.select().from(actors).limit(1);
  const res1 = await fetch("http://localhost:8787/knowledge?q=mono", {
    headers: { Authorization: `Bearer ${actor.apiKey}` }
  });
  const text1 = await res1.text();
  console.log("knowledge response:", text1);
}
run().catch(console.error);
