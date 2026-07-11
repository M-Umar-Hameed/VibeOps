import { db } from "./src/db/client.js";
import { actors } from "./src/db/schema.js";

async function run() {
  const allActors = await db.select().from(actors);
  console.log("Actors in DB:", allActors.length);
  console.log(allActors);
}
run().catch(console.error);
