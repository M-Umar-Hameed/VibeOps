import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ensureSandbox, forgeCommit, sandboxPath, sandboxDiffNames } from "../src/forge/sandbox.js";
import { runGate, resolveMutationCmd } from "../src/forge/gate.js";

const TID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

let workdir: string;
let sandboxRoot: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "gate-base-"));
  sandboxRoot = mkdtempSync(join(tmpdir(), "gate-sbx-"));
  process.env.VIBEOPS_SANDBOX_ROOT = sandboxRoot;
  git(workdir, "init", "-b", "main");
  git(workdir, "config", "user.email", "t@t");
  git(workdir, "config", "user.name", "t");
  mkdirSync(join(workdir, "src"), { recursive: true });
  writeFileSync(join(workdir, "src", "x.ts"), "export const x = 1;\n");
  writeFileSync(join(workdir, ".gitignore"), "node_modules/\n");
  git(workdir, "add", "-A");
  git(workdir, "commit", "-m", "base");
});

afterEach(() => {
  delete process.env.VIBEOPS_SANDBOX_ROOT;
  rmSync(workdir, { recursive: true, force: true });
  rmSync(sandboxRoot, { recursive: true, force: true });
});

describe("runGate integration", () => {
  it("secret scan: commit1 adds secret, commit2 redacts -> block", async () => {
    const sp = await ensureSandbox(workdir, TID);
    const secret = "Bearer " + "a".repeat(30);
    writeFileSync(join(sp, "config.txt"), secret + "\n");
    await forgeCommit(TID, "add secret");
    writeFileSync(join(sp, "config.txt"), "[redacted]\n");
    await forgeCommit(TID, "redact");

    const gate = await runGate({
      workdir, ticketId: TID,
      planText: "touch config.txt",
      ticketBody: "",
      maxSourceFiles: 3,
      mutationCmd: () => null,
    });
    expect(gate.findings.some(f => f.check === "secret" && f.severity === "block")).toBe(true);
    expect(gate.report).toContain("AUTOMATIC BLOCK");
  });

  it("file-set: stray file -> block naming only the stray", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "src", "x.ts"), "export const x = 2;\n");
    writeFileSync(join(sp, "target.txt"), "hi\n");
    await forgeCommit(TID, "changes");

    const gate = await runGate({
      workdir, ticketId: TID,
      planText: "edit src/x.ts",
      ticketBody: "",
      maxSourceFiles: 3,
      mutationCmd: () => null,
    });
    const finding = gate.findings.find(f => f.check === "file-set" && f.severity === "block");
    expect(finding).toBeDefined();
    expect(finding!.detail).toContain("target.txt");
    expect(finding!.detail).not.toContain("src/x.ts");
  });

  it("file-set: ALLOW-FILES waiver honored", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "src", "x.ts"), "export const x = 2;\n");
    writeFileSync(join(sp, "target.txt"), "hi\n");
    await forgeCommit(TID, "changes");

    const gate = await runGate({
      workdir, ticketId: TID,
      planText: "edit src/x.ts",
      ticketBody: "ALLOW-FILES: target.txt",
      maxSourceFiles: 3,
      mutationCmd: () => null,
    });
    expect(gate.findings.some(f => f.check === "file-set" && f.severity === "block")).toBe(false);
  });

  it("mutation: dead test (passes on revert) -> block; sandbox unchanged after", async () => {
    const sp = await ensureSandbox(workdir, TID);
    // Add a guard file and a "test" that always passes
    writeFileSync(join(sp, "src", "guard.ts"), "export const guard = true;\n");
    mkdirSync(join(sp, "tests"), { recursive: true });
    // This test passes regardless of guard content:
    writeFileSync(join(sp, "tests", "guard.test.ts"), `
import { describe, it, expect } from "vitest";
describe("guard", () => { it("always passes", () => { expect(1).toBe(1); }); });
`);
    await forgeCommit(TID, "add guard and test");

    // Snapshot diff before
    const diffBefore = (await sandboxDiffNames(workdir, TID)).sort();

    const gate = await runGate({
      workdir, ticketId: TID,
      planText: "add src/guard.ts and tests/guard.test.ts",
      ticketBody: "",
      maxSourceFiles: 3,
      mutationCmd: (file: string) => `npx vitest run ${file}`,
    });

    // Dead test should be caught
    const mutationBlock = gate.findings.find(f => f.check === "mutation" && f.severity === "block");
    expect(mutationBlock).toBeDefined();
    expect(mutationBlock!.detail).toContain("guard.test.ts");

    // Diff unchanged after probe
    const diffAfter = (await sandboxDiffNames(workdir, TID)).sort();
    expect(diffAfter).toEqual(diffBefore);
  });

  it("mutation: load-bearing test (fails on revert) -> no block", async () => {
    const sp = await ensureSandbox(workdir, TID);
    // Add a guard file
    writeFileSync(join(sp, "src", "guard.ts"), "export const guard = 'active';\n");
    mkdirSync(join(sp, "tests"), { recursive: true });
    // This test actually checks the guard value:
    writeFileSync(join(sp, "tests", "guard.test.ts"), `
import { describe, it, expect } from "vitest";
import { guard } from "../src/guard.js";
describe("guard", () => { it("is active", () => { expect(guard).toBe("active"); }); });
`);
    await forgeCommit(TID, "add guard and test");

    const gate = await runGate({
      workdir, ticketId: TID,
      planText: "add src/guard.ts and tests/guard.test.ts",
      ticketBody: "",
      maxSourceFiles: 3,
      mutationCmd: (file: string) => `npx vitest run ${file}`,
    });

    // Load-bearing test should NOT produce a mutation block
    const mutationBlock = gate.findings.find(f => f.check === "mutation" && f.severity === "block");
    expect(mutationBlock).toBeUndefined();
  });

  it("ac-map: unmatched AC -> warn (not block)", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "src", "x.ts"), "export const x = 2;\n");
    mkdirSync(join(sp, "tests"), { recursive: true });
    writeFileSync(join(sp, "tests", "x.test.ts"), "// tests something else\n");
    await forgeCommit(TID, "changes");

    const gate = await runGate({
      workdir, ticketId: TID,
      planText: "edit src/x.ts and tests/x.test.ts",
      ticketBody: `## Acceptance criteria
- Widget exports correctly
- Frobnicator handles edge case
`,
      maxSourceFiles: 3,
      mutationCmd: () => null,
    });

    const acWarn = gate.findings.find(f => f.check === "ac-map");
    expect(acWarn).toBeDefined();
    expect(acWarn!.severity).toBe("warn");
    expect(acWarn!.detail).toContain("Widget");
  });
});

describe("resolveMutationCmd", () => {
  it("uses setting with {file} placeholder", () => {
    const cmd = resolveMutationCmd("npm test -- {file}", workdir);
    expect(cmd("foo.test.ts")).toBe("npm test -- foo.test.ts");
  });

  it("detects vitest from package.json", () => {
    writeFileSync(join(workdir, "package.json"), JSON.stringify({
      devDependencies: { vitest: "^1.0.0" },
    }));
    const cmd = resolveMutationCmd(null, workdir);
    expect(cmd("foo.test.ts")).toBe("npx vitest run foo.test.ts");
  });

  it("returns null when no runner detected", () => {
    writeFileSync(join(workdir, "package.json"), JSON.stringify({}));
    const cmd = resolveMutationCmd(null, workdir);
    expect(cmd("foo.test.ts")).toBeNull();
  });
});

describe("citation check", () => {
  it("doc cites real in-range source line -> no citation finding; gate.citations contains quoted text", async () => {
    const sp = await ensureSandbox(workdir, TID);
    mkdirSync(join(sp, "docs"), { recursive: true });
    // doc cites src/x.ts:1 which exists in the sandbox
    writeFileSync(join(sp, "docs", "spec.md"), "# Spec\nSee src/x.ts:1 for details.\n");
    await forgeCommit(TID, "add doc");

    const gate = await runGate({
      workdir, ticketId: TID,
      planText: "add docs/spec.md",
      ticketBody: "",
      maxSourceFiles: 3,
      mutationCmd: () => null,
    });
    expect(gate.findings.some(f => f.check === "citation")).toBe(false);
    expect(gate.citations).toContain("src/x.ts:1");
    expect(gate.citations).toContain("export const x = 1;");
  });

  it("doc cites missing file -> citation block finding with AUTOMATIC BLOCK", async () => {
    const sp = await ensureSandbox(workdir, TID);
    mkdirSync(join(sp, "docs"), { recursive: true });
    writeFileSync(join(sp, "docs", "spec.md"), "# Spec\nSee nope/missing.ts:3 for details.\n");
    await forgeCommit(TID, "add doc");

    const gate = await runGate({
      workdir, ticketId: TID,
      planText: "add docs/spec.md",
      ticketBody: "",
      maxSourceFiles: 3,
      mutationCmd: () => null,
    });
    const finding = gate.findings.find(f => f.check === "citation" && f.severity === "block");
    expect(finding).toBeDefined();
    expect(finding!.detail).toContain("file not found");
    expect(gate.report).toContain("AUTOMATIC BLOCK");
  });

  it("doc cites out-of-range line -> citation block finding with line count", async () => {
    const sp = await ensureSandbox(workdir, TID);
    mkdirSync(join(sp, "docs"), { recursive: true });
    // src/x.ts has 1 line; citing line 9999 is out of range
    writeFileSync(join(sp, "docs", "spec.md"), "# Spec\nSee src/x.ts:9999 for details.\n");
    await forgeCommit(TID, "add doc");

    const gate = await runGate({
      workdir, ticketId: TID,
      planText: "add docs/spec.md",
      ticketBody: "",
      maxSourceFiles: 3,
      mutationCmd: () => null,
    });
    const finding = gate.findings.find(f => f.check === "citation" && f.severity === "block");
    expect(finding).toBeDefined();
    expect(finding!.detail).toContain("has 2 lines");
    expect(gate.report).toContain("AUTOMATIC BLOCK");
  });

  it("non-doc file (.ts) with file:line token -> no citation finding", async () => {
    const sp = await ensureSandbox(workdir, TID);
    // put a file:line reference in a .ts file, not a doc
    writeFileSync(join(sp, "src", "x.ts"), "// see src/x.ts:1\nexport const x = 2;\n");
    await forgeCommit(TID, "edit ts");

    const gate = await runGate({
      workdir, ticketId: TID,
      planText: "edit src/x.ts",
      ticketBody: "",
      maxSourceFiles: 3,
      mutationCmd: () => null,
    });
    expect(gate.findings.some(f => f.check === "citation")).toBe(false);
  });
});
