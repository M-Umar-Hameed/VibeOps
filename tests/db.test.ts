import { expect, test } from "vitest";
import { sql } from "../src/db/client.js";
import { EMBEDDED } from "./helpers/embedded.js";

test.skipIf(EMBEDDED)("postgres is reachable", async () => {
  const rows = await sql`select 1 as n`;
  expect(rows[0].n).toBe(1);
});
