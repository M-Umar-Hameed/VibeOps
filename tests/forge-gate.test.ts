import { describe, it, expect } from "vitest";
import {
  isTestPath, extractDeclaredPaths, unexpectedFiles,
  extractAcceptanceCriteria, unmatchedCriteria, mutationCandidate,
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
