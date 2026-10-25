import { expect, test } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";

// drizzle migrate() applies only entries whose `when` is newer than the latest
// applied created_at, so an out-of-order `when` is skipped silently on existing
// databases (0023 in 86f3a2f). Pure file check: runs on every lane.
const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf-8"));
const entries: { idx: number; when: number; tag: string }[] = journal.entries;

test("journal entries are sequential, strictly newer, and have their sql file", () => {
  entries.forEach((e, i) => {
    expect(e.idx, `entry ${i} has idx ${e.idx}`).toBe(i);
    if (i > 0) {
      const prev = entries[i - 1].when;
      expect(e.when > prev, `idx ${e.idx} (${e.tag}) when ${e.when} is not newer than idx ${i - 1} when ${prev}`).toBe(true);
    }
    expect(e.tag.startsWith(String(i).padStart(4, "0") + "_"), `idx ${e.idx} tag ${e.tag} does not start with ${String(i).padStart(4, "0")}_`).toBe(true);
    expect(existsSync(`drizzle/${e.tag}.sql`), `idx ${e.idx} missing drizzle/${e.tag}.sql`).toBe(true);
  });
});

test("every drizzle/*.sql file has a journal entry", () => {
  const tags = new Set(entries.map((e) => e.tag));
  for (const f of readdirSync("drizzle").filter((f) => f.endsWith(".sql"))) {
    expect(tags.has(f.slice(0, -4)), `drizzle/${f} has no journal entry`).toBe(true);
  }
});
