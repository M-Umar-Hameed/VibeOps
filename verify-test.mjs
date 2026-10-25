import { existsSync, readdirSync, readFileSync } from "node:fs";

const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf-8"));
const entries = journal.entries;

console.log("Test 1: journal entries are sequential, strictly newer, and have their sql file");
let pass = true;
entries.forEach((e, i) => {
  if (e.idx !== i) {
    console.log(`  FAIL: entry ${i} has idx ${e.idx}`);
    pass = false;
  }
  if (i > 0) {
    const prev = entries[i - 1].when;
    if (!(e.when > prev)) {
      console.log(`  FAIL: idx ${e.idx} (${e.tag}) when ${e.when} is not newer than idx ${i - 1} when ${prev}`);
      pass = false;
    }
  }
  if (!e.tag.startsWith(String(i).padStart(4, "0") + "_")) {
    console.log(`  FAIL: idx ${e.idx} tag ${e.tag} does not start with ${String(i).padStart(4, "0")}_`);
    pass = false;
  }
  if (!existsSync(`drizzle/${e.tag}.sql`)) {
    console.log(`  FAIL: idx ${e.idx} missing drizzle/${e.tag}.sql`);
    pass = false;
  }
});
if (pass) console.log("  PASS");

console.log("\nTest 2: every drizzle/*.sql file has a journal entry");
const tags = new Set(entries.map((e) => e.tag));
let pass2 = true;
for (const f of readdirSync("drizzle").filter((f) => f.endsWith(".sql"))) {
  if (!tags.has(f.slice(0, -4))) {
    console.log(`  FAIL: drizzle/${f} has no journal entry`);
    pass2 = false;
  }
}
if (pass2) console.log("  PASS");

console.log(`\nOverall: ${pass && pass2 ? "PASS" : "FAIL"}`);
if (!pass || !pass2) {
  console.log("\nExpected failure detected: test correctly catches out-of-order when values");
  process.exit(0);
} else {
  console.log("\nERROR: Test should have failed but passed");
  process.exit(1);
}
