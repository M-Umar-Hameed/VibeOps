import { expect, test } from "vitest";
import { sql } from "../src/db/client.js";
import { db } from "../src/db/client.js";
import { actors, events } from "../src/db/schema.js";
import { EMBEDDED } from "./helpers/embedded.js";

test.skipIf(EMBEDDED)("vector extension, new tables, and generalized events exist", async () => {
  const ext = await sql`select 1 from pg_extension where extname = 'vector'`;
  expect(ext.length).toBe(1);
  const tbls = await sql`select table_name from information_schema.tables where table_schema='public'`;
  const names = tbls.map((r) => r.table_name);
  expect(names).toContain("notes");
  expect(names).toContain("embeddings");
});

test.skipIf(EMBEDDED)("events CHECK rejects a row with neither ticketId nor noteId", async () => {
  const [a] = await db.insert(actors)
    .values({ name: "ck", kind: "agent", apiKeyHash: `h-${Date.now()}` }).returning();
  await expect(
    db.insert(events).values({ actorId: a.id, action: "bogus" }),
  ).rejects.toBeTruthy();
});
