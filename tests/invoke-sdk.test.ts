import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { checkToolPermission, runAgentSdk, hasCredentials, buildSdkOptions, sdkEnv, riskHook } from "../src/relay/invoke-sdk.js";

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

  it("denies Bash when the wall is on and allows it when off", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "sdk-wall-"));
    const marks: string[] = [];
    expect(checkToolPermission("Bash", { command: "node -e 1" }, sandbox, (c) => marks.push(c), true).behavior).toBe("deny");
    expect(marks.join("")).toContain("permission-denied Bash");
    expect(checkToolPermission("Bash", { command: "node -e 1" }, sandbox).behavior).toBe("allow");
  });
});

describe("hasCredentials", () => {
  it("returns false when no env token and no .credentials.json", () => {
    const prevTok = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    try {
      const dir = mkdtempSync(join(tmpdir(), "cred-"));
      expect(hasCredentials(dir)).toBe(false);
      rmSync(dir, { recursive: true, force: true });
    } finally {
      if (prevTok !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = prevTok;
    }
  });

  it("returns true when .credentials.json exists", () => {
    const prevTok = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    try {
      const dir = mkdtempSync(join(tmpdir(), "cred-"));
      writeFileSync(join(dir, ".credentials.json"), "{}");
      expect(hasCredentials(dir)).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    } finally {
      if (prevTok !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = prevTok;
    }
  });
});

describe("runAgentSdk credentials", () => {
  it("fails with an actionable message when no credentials and no login file", async () => {
    const prevTok = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const prevCfg = process.env.CLAUDE_CONFIG_DIR;
    const prevHome = process.env.HOME, prevUP = process.env.USERPROFILE;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CONFIG_DIR;
    const emptyHome = mkdtempSync(join(tmpdir(), "sdk-home-"));
    process.env.HOME = emptyHome; process.env.USERPROFILE = emptyHome;
    try {
      const res = await runAgentSdk({ type: "sdk", roles: ["work"] } as any, "hi", emptyHome);
      expect(res.ok).toBe(false);
      expect(res.output).toContain("claude setup-token");
    } finally {
      if (prevTok !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = prevTok;
      if (prevCfg !== undefined) process.env.CLAUDE_CONFIG_DIR = prevCfg;
      if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
      if (prevUP !== undefined) process.env.USERPROFILE = prevUP; else delete process.env.USERPROFILE;
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});

describe("buildSdkOptions", () => {
  const names = ["SlashCommand", "Skill", "Task", "Agent", "BashOutput", "TaskOutput", "KillShell"];
  it("disallows background and sub-agent tools with the wall on and off", () => {
    for (const on of [true, false]) {
      const o = buildSdkOptions({}, tmpdir(), on, ["npm test"]);
      for (const n of names) expect(o.disallowedTools).toContain(n);
      expect(o.disallowedTools).toContain("Bash(git *--output*)");
    }
  });

  it("hook denies run_in_background for Bash and PowerShell and allows a plain call", async () => {
    const hook = buildSdkOptions({}, tmpdir(), true, []).hooks.PreToolUse[0].hooks[0];
    const sig = { signal: new AbortController().signal };
    for (const tool of ["Bash", "PowerShell"]) {
      const r: any = await hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command: "npx vitest run", run_in_background: true } } as any, undefined, sig);
      expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(r.hookSpecificOutput.permissionDecisionReason).toContain("run it in the foreground");
    }
    const ok: any = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npx vitest run" } } as any, undefined, sig);
    expect(ok.hookSpecificOutput).toBeUndefined();
  });

  it("registers the background hook and the risk hook", () => {
    expect(buildSdkOptions({}, tmpdir(), false, []).hooks.PreToolUse[0].hooks).toHaveLength(2);
  });
});

describe("riskHook", () => {
  const sig = { signal: new AbortController().signal } as any;
  const call = (tool: string, command: string, lifted: string[] = [], onData?: (c: string) => void) =>
    riskHook(tmpdir(), lifted, onData)({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command } } as any, undefined, sig) as Promise<any>;

  it("denies git push for Bash and PowerShell and reports it", async () => {
    for (const tool of ["Bash", "PowerShell"]) {
      const chunks: string[] = [];
      const r = await call(tool, "git push", [], (c) => chunks.push(c));
      expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(r.hookSpecificOutput.permissionDecisionReason).toContain("git-push");
      expect(chunks[0].startsWith("\n[forge: permission-denied Bash git push")).toBe(true);
    }
  });

  it("allows a safe command and a lifted rule", async () => {
    expect(await call("Bash", "npm test")).toEqual({});
    expect(await call("Bash", "git push", ["git-push"])).toEqual({});
  });

  it("uses the PowerShell dialect for the PowerShell tool", async () => {
    const r = await call("PowerShell", "del ../x");
    expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

describe("sdkEnv", () => {
  it("adds BASH_MAX_TIMEOUT_MS and BASH_DEFAULT_TIMEOUT_MS", () => {
    const env = sdkEnv({ type: "sdk", roles: ["work"], cmd: [] }, tmpdir(), {});
    expect(env.BASH_MAX_TIMEOUT_MS).toBe(process.env.BASH_MAX_TIMEOUT_MS ?? "1200000");
    expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe(process.env.BASH_DEFAULT_TIMEOUT_MS ?? "1200000");
  });

  it("passes agent.env CLAUDE_CONFIG_DIR with no account and substitutes {workdir}", () => {
    const env = sdkEnv({ type: "sdk", roles: ["work"], cmd: [], env: { CLAUDE_CONFIG_DIR: "{workdir}/.claude-b" } }, "/w", {});
    expect(env.CLAUDE_CONFIG_DIR).toBe("/w/.claude-b");
  });

  it("account env overrides agent.env", () => {
    const env = sdkEnv({ type: "sdk", roles: ["work"], cmd: [], env: { CLAUDE_CONFIG_DIR: "/lane" } }, "/w", { CLAUDE_CONFIG_DIR: "/acct" });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/acct");
  });
});
