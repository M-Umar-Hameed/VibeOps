import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_PROTECTED_GLOBS, resolveProtectedPaths, parseAllowProtected, evaluateProtectedPaths,
} from "../src/forge/policy.js";

describe("forge protected-path policy", () => {
  it("resolveProtectedPaths: null -> defaults", () => {
    expect(resolveProtectedPaths(null)).toEqual(DEFAULT_PROTECTED_GLOBS);
  });
  it("resolveProtectedPaths: valid array overrides (incl. empty)", () => {
    expect(resolveProtectedPaths('["a/**","b.json"]')).toEqual(["a/**", "b.json"]);
    expect(resolveProtectedPaths("[]")).toEqual([]);
  });
  it("resolveProtectedPaths: malformed or non-string-array -> defaults + warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveProtectedPaths("not json")).toEqual(DEFAULT_PROTECTED_GLOBS);
    expect(resolveProtectedPaths('{"a":1}')).toEqual(DEFAULT_PROTECTED_GLOBS);
    expect(resolveProtectedPaths('["ok",2]')).toEqual(DEFAULT_PROTECTED_GLOBS);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it("parseAllowProtected: extracts, splits, trims; none -> []", () => {
    expect(parseAllowProtected("preamble\nALLOW-PROTECTED: vitest.config.ts, tests/setup.ts\nmore"))
      .toEqual(["vitest.config.ts", "tests/setup.ts"]);
    expect(parseAllowProtected("no allowance here")).toEqual([]);
  });
  it("flags each default protected glob", () => {
    const flagged = [
      "vitest.config.ts", "jest.config.js", "tests/global-setup.ts", "tests/setup.ts",
      "playwright.config.ts", ".github/workflows/ci.yml", "tsconfig.json", "tsconfig.build.json",
      "package.json", "package-lock.json", "bun.lock", "tests/security-audit.test.ts",
      "tests/no-dangerous-html.test.ts",
    ];
    expect(evaluateProtectedPaths(flagged, DEFAULT_PROTECTED_GLOBS, [])).toEqual(flagged);
  });
  it("passes ordinary src/ and tests/*.test.ts paths", () => {
    const ok = ["src/forge/checks.ts", "src/index.ts", "tests/forge-runs.test.ts", "app/src/routes/list.tsx"];
    expect(evaluateProtectedPaths(ok, DEFAULT_PROTECTED_GLOBS, [])).toEqual([]);
  });
  it("allowance waives a specific protected path", () => {
    expect(evaluateProtectedPaths(["vitest.config.ts", "package.json"], DEFAULT_PROTECTED_GLOBS, ["vitest.config.ts"]))
      .toEqual(["package.json"]);
  });
});
