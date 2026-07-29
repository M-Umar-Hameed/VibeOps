import { describe, it, expect } from "vitest";
import { resolveChecks, runChecks } from "../src/forge/checks.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("forge checks", () => {
  it("resolveChecks uses valid JSON array setting", () => {
    expect(resolveChecks('["npm run typecheck","npm test"]', "")).toEqual(["npm run typecheck", "npm test"]);
  });

  it("resolveChecks falls back to detection on invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-checks-test-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "node typecheck.js" } }));
      expect(resolveChecks("not json", dir)).toEqual(["npm run typecheck"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveChecks detects typecheck script if unset, empty if no package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-checks-test-"));
    try {
      expect(resolveChecks(null, dir)).toEqual([]);
      expect(resolveChecks("[]", dir)).toEqual([]);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "node typecheck.js" } }));
      expect(resolveChecks(null, dir)).toEqual(["npm run typecheck"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runChecks captures exactly 100 tail lines on success", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "forge-checks-test-"));
    try {
      const results = await runChecks([`node "${join(__dirname, "fixtures", "check-lines.mjs")}"`], tmp);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe(0);
      const lines = results[0].tail.split("\n");
      expect(lines).toHaveLength(100);
      expect(lines[0]).toBe("line-51");
      expect(lines[lines.length - 1]).toBe("line-150");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("runChecks captures exit code and cwd in tail on failure", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "forge-checks-test-"));
    try {
      const results = await runChecks([`node "${join(__dirname, "fixtures", "check-fail.mjs")}"`], tmp);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe(1);
      expect(results[0].tail).toContain("TSCHECK-ERROR");
      expect(results[0].tail).toContain(`cwd=${tmp}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("runChecks kills hanging process and reports timeout", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "forge-checks-test-"));
    try {
      const results = await runChecks([`node "${join(__dirname, "fixtures", "check-hang.mjs")}"`], tmp, 500);
      expect(results).toHaveLength(1);
      expect(results[0].code).not.toBe(0);
      expect(results[0].tail).toContain("check timed out");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
