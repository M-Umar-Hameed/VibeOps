import { describe, it, expect } from "vitest";
import { unexpectedFiles } from "../src/forge/gate.js";
import { elideGeneratedDiffs, reviewDiffPayload } from "../src/forge/runs.js";

describe("drizzle companions and generated-diff elision", () => {
  it("generated drizzle files are in scope when the plan declares the schema", () => {
    const declared = new Set(["src/db/schema.ts", "src/chat/store.ts"]);
    const changed = [
      "src/db/schema.ts",
      "drizzle/0017_married_supernaut.sql",
      "drizzle/meta/0017_snapshot.json",
      "drizzle/meta/_journal.json",
      "src/rogue.ts",
    ];
    expect(unexpectedFiles(changed, declared, [])).toEqual(["src/rogue.ts"]);
  });

  it("drizzle files still flag when the plan never touches the schema", () => {
    const declared = new Set(["src/api/app.ts"]);
    const changed = ["drizzle/0017_x.sql", "drizzle/meta/0017_snapshot.json"];
    expect(unexpectedFiles(changed, declared, []).length).toBe(2);
  });

  it("snapshot bodies are elided so source survives the cap", () => {
    const snap = `diff --git a/drizzle/meta/0018_snapshot.json b/drizzle/meta/0018_snapshot.json\n` +
      "+{\n" + `+  "x": 1,\n`.repeat(3000) + "+}\n";
    const src = `diff --git a/src/forge/runs.ts b/src/forge/runs.ts\n+const real = 1;\n`;
    const out = reviewDiffPayload(snap + src, "stat", 10_000);
    expect(out).toContain("generated file elided from review diff: drizzle/meta/0018_snapshot.json");
    expect(out).toContain("const real = 1;");
    expect(out).not.toContain('"x": 1');
  });

  it("non-generated diffs pass through untouched", () => {
    const d = `diff --git a/src/a.ts b/src/a.ts\n+line\n`;
    expect(elideGeneratedDiffs(d)).toBe(d);
  });
});
