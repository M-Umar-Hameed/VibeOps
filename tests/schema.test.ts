import { expect, test } from "vitest";
import { sql } from "../src/db/client.js";
import { EMBEDDED } from "./helpers/embedded.js";

test.skipIf(EMBEDDED)("all core tables exist", async () => {
  const rows = await sql`
    select table_name from information_schema.tables
    where table_schema = 'public'`;
  const names = rows.map((r) => r.table_name);
  for (const t of ["projects", "actors", "tickets", "comments", "events"]) {
    expect(names).toContain(t);
  }
});
