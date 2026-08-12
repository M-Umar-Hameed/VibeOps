import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isTestPath, extractDeclaredPaths, unexpectedFiles,
  extractAcceptanceCriteria, unmatchedCriteria, mutationCandidate,
  isDocPath, addedLinesByFile, extractCitations, resolveCitation,
} from "../src/forge/gate.js";

describe("isTestPath", () => {
  it("matches common test file patterns", () => {
    expect(isTestPath("src/forge/gate.test.ts")).toBe(true);
    expect(isTestPath("foo.spec.js")).toBe(true);
    expect(isTestPath("tests/foo.ts")).toBe(true);
    expect(isTestPath("test/bar.js")).toBe(true);
  });
  it("rejects non-test files", () => {
    expect(isTestPath("src/forge/gate.ts")).toBe(false);
    expect(isTestPath("package.json")).toBe(false);
  });
});

describe("extractDeclaredPaths", () => {
  it("extracts full paths and basenames from plan text", () => {
    const plan = "touch src/forge/gate.ts and gate.test.ts";
    const declared = extractDeclaredPaths(plan);
    expect(declared.has("src/forge/gate.ts")).toBe(true);
    expect(declared.has("gate.ts")).toBe(true);
    expect(declared.has("gate.test.ts")).toBe(true);
  });
  it("strips leading ./ or /", () => {
    const declared = extractDeclaredPaths("edit ./foo/bar.ts and /baz.js");
    expect(declared.has("foo/bar.ts")).toBe(true);
    expect(declared.has("baz.js")).toBe(true);
  });
});

describe("unexpectedFiles", () => {
  it("returns files not in declared set", () => {
    const declared = new Set(["src/forge/gate.ts", "gate.ts"]);
    const result = unexpectedFiles(["src/forge/gate.ts", "target.txt", "query"], declared, []);
    expect(result).toEqual(["target.txt", "query"]);
  });
  it("respects ALLOW-FILES globs", () => {
    const declared = new Set(["src/x.ts"]);
    const result = unexpectedFiles(["src/x.ts", "target.txt"], declared, ["target.txt"]);
    expect(result).toEqual([]);
  });
  it("allows by basename match", () => {
    const declared = new Set(["gate.ts"]);
    const result = unexpectedFiles(["src/forge/gate.ts"], declared, []);
    expect(result).toEqual([]);
  });
});

describe("extractAcceptanceCriteria", () => {
  it("extracts lines after 'acceptance criteria'", () => {
    const body = `# Summary
Some text

## Acceptance criteria
- Secret scan blocks promotion
- File-set check works

## Notes
`;
    const criteria = extractAcceptanceCriteria(body);
    expect(criteria).toEqual(["Secret scan blocks promotion", "File-set check works"]);
  });
  it("returns empty for no AC section", () => {
    expect(extractAcceptanceCriteria("just some text")).toEqual([]);
  });
});

describe("unmatchedCriteria", () => {
  it("returns criteria whose keywords appear in no test text", () => {
    const criteria = ["secret scan blocks promotion"];
    const tests = ["test('handles secret scan', () => {})"];
    expect(unmatchedCriteria(criteria, tests)).toEqual([]);
  });
  it("returns unmatched when no keyword found", () => {
    const criteria = ["widget exports correctly"];
    const tests = ["test('something else', () => {})"];
    expect(unmatchedCriteria(criteria, tests)).toEqual(["widget exports correctly"]);
  });
});

describe("mutationCandidate", () => {
  it("returns null when no added test", () => {
    const ns = [{ status: "M" as const, path: "src/x.ts" }];
    expect(mutationCandidate(ns, 3)).toBeNull();
  });
  it("returns split when 1 test + 1 source", () => {
    const ns = [
      { status: "A" as const, path: "tests/x.test.ts" },
      { status: "M" as const, path: "src/x.ts" },
    ];
    const cand = mutationCandidate(ns, 3);
    expect(cand?.testFiles).toEqual(["tests/x.test.ts"]);
    expect(cand?.sourceFiles).toEqual([{ status: "M", path: "src/x.ts" }]);
  });
  it("returns null when sourceFiles > maxSource", () => {
    const ns = [
      { status: "A" as const, path: "tests/x.test.ts" },
      { status: "M" as const, path: "src/a.ts" },
      { status: "M" as const, path: "src/b.ts" },
      { status: "M" as const, path: "src/c.ts" },
      { status: "M" as const, path: "src/d.ts" },
    ];
    expect(mutationCandidate(ns, 3)).toBeNull();
  });
});

describe("isDocPath", () => {
  it("matches .md/.txt documentation files", () => {
    expect(isDocPath("docs/spec.md")).toBe(true);
    expect(isDocPath("README.txt")).toBe(true);
    expect(isDocPath("notes.markdown")).toBe(true);
    expect(isDocPath("blog.mdx")).toBe(true);
  });
  it("rejects non-doc files", () => {
    expect(isDocPath("src/x.ts")).toBe(false);
    expect(isDocPath("package.json")).toBe(false);
  });
});

describe("addedLinesByFile", () => {
  it("extracts added lines per file from a patch", () => {
    const patch = `diff --git a/docs/x.md b/docs/x.md
--- a/docs/x.md
+++ b/docs/x.md
@@ -1 +1,2 @@
 old line
+cite src/a.ts:5
diff --git a/docs/y.md b/docs/y.md
--- /dev/null
+++ b/docs/y.md
@@ -0,0 +1 @@
+new file line`;
    const map = addedLinesByFile(patch);
    expect(map.get("docs/x.md")).toContain("cite src/a.ts:5");
    expect(map.get("docs/y.md")).toContain("new file line");
  });
  it("does not collect +++ header line itself as content", () => {
    const patch = `diff --git a/docs/x.md b/docs/x.md
+++ b/docs/x.md
@@ -1 +1,2 @@
+real line`;
    const map = addedLinesByFile(patch);
    expect(map.get("docs/x.md")).toBe("real line");
    expect(map.get("docs/x.md")).not.toContain("+++");
  });
});

describe("extractCitations", () => {
  it("extracts file:line and file:line-line citations", () => {
    const text = "see src/services/comments.ts:12 and knowledge.ts:100-120";
    const refs = extractCitations(text);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({ raw: "src/services/comments.ts:12", path: "src/services/comments.ts", start: 12, end: 12 });
    expect(refs[1]).toEqual({ raw: "knowledge.ts:100-120", path: "knowledge.ts", start: 100, end: 120 });
  });
  it("does not match prose like 'step 3:12'", () => {
    expect(extractCitations("step 3:12 something")).toEqual([]);
  });
  it("does not match bare paths without line numbers", () => {
    expect(extractCitations("see src/relay for details")).toEqual([]);
  });
});

describe("resolveCitation", () => {
  let sandbox: string;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "citation-test-"));
    mkdirSync(join(sandbox, "src"), { recursive: true });
    writeFileSync(join(sandbox, "src", "x.ts"), "line1\nline2\nline3\n");
  });
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("returns ok with quoted text for in-range citation", () => {
    const ref = { raw: "src/x.ts:2", path: "src/x.ts", start: 2, end: 2 };
    const result = resolveCitation(sandbox, ref);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.quoted).toBe("line2");
  });

  it("returns out-of-range with lineCount for line past EOF", () => {
    const ref = { raw: "src/x.ts:9999", path: "src/x.ts", start: 9999, end: 9999 };
    const result = resolveCitation(sandbox, ref);
    expect(result.status).toBe("out-of-range");
    if (result.status === "out-of-range") expect(result.lineCount).toBe(4); // 3 lines + trailing newline split
  });

  it("returns missing for non-existent file", () => {
    const ref = { raw: "nope.ts:1", path: "nope.ts", start: 1, end: 1 };
    const result = resolveCitation(sandbox, ref);
    expect(result.status).toBe("missing");
  });

  it("returns missing for path traversal attempt", () => {
    const ref = { raw: "../escape.ts:1", path: "../escape.ts", start: 1, end: 1 };
    const result = resolveCitation(sandbox, ref);
    expect(result.status).toBe("missing");
  });
});
