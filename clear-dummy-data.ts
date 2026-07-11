import { db } from "./src/db/client.js";
import { tickets, projects, comments, notes, events, embeddings, syncLinks, syncCommentLinks } from "./src/db/schema.js";

async function clear() {
  console.log("Clearing dummy data...");
  await db.delete(syncCommentLinks);
  await db.delete(syncLinks);
  await db.delete(embeddings);
  await db.delete(events);
  await db.delete(notes);
  await db.delete(comments);
  await db.delete(tickets);
  await db.delete(projects);
  console.log("Dummy data cleared successfully.");
  process.exit(0);
}

clear().catch(err => {
  console.error("Error clearing dummy data:", err);
  process.exit(1);
});
