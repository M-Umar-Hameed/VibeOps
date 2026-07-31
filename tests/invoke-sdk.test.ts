import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { checkToolPermission, runAgentSdk } from "../src/relay/invoke-sdk.js";

describe("checkToolPermission", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "sdk-sbx-"));

  it("allows a write inside the sandbox", () => {
    const r = checkToolPermission("Write", { file_path: join(sandbox, "a.ts") }, sandbox);
    expect(r.behavior).toBe("allow");
  });

  it("allows read-only tools", () => {
    expect(checkToolPermission("Read", { file_path: "/etc/hosts" }, sandbox).behavior).toBe("allow");
    expect(checkToolPermission("Grep", {}, sandbox).behavior).toBe("allow");
  });

  it("denies a ../ traversal escaping the sandbox and emits the marker", () => {
    const marks: string[] = [];
    const r = checkToolPermission("Edit", { file_path: "../evil.ts" }, sandbox, (c) => marks.push(c));
    expect(r.behavior).toBe("deny");
    expect(marks.join("")).toContain("[forge: permission-denied Edit ../evil.ts]");
  });

  it("denies a sibling-prefix path (/sandbox-evil vs /sandbox)", () => {
    const evil = sandbox + "-evil";
    mkdirSync(evil, { recursive: true });
    const r = checkToolPermission("Write", { file_path: join(evil, "x.ts") }, sandbox);
    expect(r.behavior).toBe("deny");
    rmSync(evil, { recursive: true, force: true });
  });

  it("denies an unknown tool with a marker", () => {
    const marks: string[] = [];
    const r = checkToolPermission("WebFetch", { url: "http://x" }, sandbox, (c) => marks.push(c));
    expect(r.behavior).toBe("deny");
    expect(marks.join("")).toContain("[forge: permission-denied WebFetch");
  });
});

describe("runAgentSdk credentials", () => {
  it("fails with an actionable message when no credentials and no login file", async () => {
    const prevTok = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const prevHome = process.env.HOME, prevUP = process.env.USERPROFILE;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const emptyHome = mkdtempSync(join(tmpdir(), "sdk-home-"));
    process.env.HOME = emptyHome; process.env.USERPROFILE = emptyHome;
    try {
      const res = await runAgentSdk({ type: "sdk", roles: ["work"] } as any, "hi", emptyHome);
      expect(res.ok).toBe(false);
      expect(res.output).toContain("claude setup-token");
    } finally {
      if (prevTok !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = prevTok;
      if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
      if (prevUP !== undefined) process.env.USERPROFILE = prevUP; else delete process.env.USERPROFILE;
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});
