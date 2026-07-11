import { db } from "./src/db/client.js";
import { actors } from "./src/db/schema.js";
import { eq } from "drizzle-orm";

async function run() {
  const [actor] = await db.select().from(actors).limit(1);
  if (!actor) { console.log("No actor"); process.exit(0); }
  
  const res1 = await fetch("http://localhost:8787/knowledge?q=mono", {
    headers: { Authorization: `Bearer ${actor.apiKey}` }
  });
  const hits = await res1.json();
  console.log("Hits:", hits.length);
  if (hits.length === 0) { console.log("No hits"); process.exit(0); }
  
  const hit = hits[0];
  console.log("Fetching source:", hit.sourceKind, hit.sourceRef);
  
  const qs = `?kind=${hit.sourceKind}&ref=${encodeURIComponent(hit.sourceRef)}`;
  const res2 = await fetch(`http://localhost:8787/knowledge/source${qs}`, {
    headers: { Authorization: `Bearer ${actor.apiKey}` }
  });
  
  console.log("Status:", res2.status);
  const text = await res2.text();
  console.log("Body:", text.substring(0, 100));
  process.exit(0);
}
run().catch(console.error);
