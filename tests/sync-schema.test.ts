import { expect, test } from "vitest";
import { sql } from "../src/db/client.js";

test("sync tables exist", async () => {
  const rows = await sql`select table_name from information_schema.tables where table_schema='public'`;
  const names = rows.map((r) => r.table_name);
  expect(names).toContain("sync_links");
  expect(names).toContain("sync_comment_links");
});
