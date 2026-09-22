import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ensureSandbox, forgeCommit } from "../src/forge/sandbox.js";
import { runGate } from "../src/forge/gate.js";
import { parseGateOverrides } from "../src/forge/policy.js";

const TID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

describe("parseGateOverrides", () => {
  it("parses a comma list, case-insensitively", () => {
    expect(parseGateOverrides("preamble\nGATE-OVERRIDE: Secret, Citation\nmore"))
      .toEqual(new Set(["secret", "citation"]));
  });
  it("returns an empty set for a body with no directive", () => {
    expect(parseGateOverrides("no directive here")).toEqual(new Set());
  });
});

let workdir: string;
let sandboxRoot: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "gate-override-base-"));
  sandboxRoot = mkdtempSync(join(tmpdir(), "gate-override-sbx-"));
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

describe("runGate with GATE-OVERRIDE", () => {
  it("GATE-OVERRIDE: all downgrades a secret block that the same input without it produces", async () => {
    const sp = await ensureSandbox(workdir, TID);
    const secret = "Bearer " + "a".repeat(30);
    writeFileSync(join(sp, "config.txt"), secret + "\n");
    await forgeCommit(TID, "add secret");

    const withoutOverride = await runGate({
      workdir, ticketId: TID,
      planText: "touch config.txt",
      ticketBody: "",
      maxSourceFiles: 3,
      mutationCmd: () => null,
    });
    expect(withoutOverride.findings.some(f => f.severity === "block")).toBe(true);

    const withOverride = await runGate({
      workdir, ticketId: TID,
      planText: "touch config.txt",
      ticketBody: "GATE-OVERRIDE: all",
      maxSourceFiles: 3,
      mutationCmd: () => null,
    });
    expect(withOverride.findings.some(f => f.severity === "block")).toBe(false);
    const secretFinding = withOverride.findings.find(f => f.check === "secret");
    expect(secretFinding?.severity).toBe("warn");
    expect(withOverride.report).toContain("GATE-OVERRIDE in the ticket body");
  });

  it("GATE-OVERRIDE: secret downgrades only the secret finding; a different check still blocks", async () => {
    const sp = await ensureSandbox(workdir, TID);
    const secret = "Bearer " + "a".repeat(30);
    writeFileSync(join(sp, "config.txt"), secret + "\n");
    writeFileSync(join(sp, "target.txt"), "stray file outside the plan\n");
    await forgeCommit(TID, "add secret and stray file");

    const gate = await runGate({
      workdir, ticketId: TID,
      planText: "touch config.txt",
      ticketBody: "GATE-OVERRIDE: secret",
      maxSourceFiles: 3,
      mutationCmd: () => null,
    });

    const secretFinding = gate.findings.find(f => f.check === "secret");
    expect(secretFinding?.severity).toBe("warn");
    const fileSetFinding = gate.findings.find(f => f.check === "file-set");
    expect(fileSetFinding?.severity).toBe("block");
    expect(gate.findings.some(f => f.severity === "block")).toBe(true);
  });
});
