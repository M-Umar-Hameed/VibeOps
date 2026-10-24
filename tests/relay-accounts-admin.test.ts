import { describe, it, expect } from "vitest";
import { loginCommand, accountRunStats } from "../src/relay/accounts-admin.js";

describe("accounts-admin", () => {
  it("loginCommand per platform", () => {
    expect(loginCommand("claude", "C:\\a", "win32")).toEqual({ command: '$env:CLAUDE_CONFIG_DIR="C:\\a"; claude', then: "type /login" });
    expect(loginCommand("claude-sdk", "/h/a", "linux")).toEqual({ command: 'CLAUDE_CONFIG_DIR="/h/a" claude', then: "type /login" });
    expect(loginCommand("codex", "/h/c", "linux")).toEqual({ command: 'CODEX_HOME="/h/c" codex login' });
    expect(loginCommand("gemini", "/h/g", "linux")).toBeUndefined();
  });

  it("accountRunStats counts stages per agent and account, newest first", () => {
    const t1 = new Date("2026-10-24T10:00:00Z");
    const t0 = new Date("2026-10-23T10:00:00Z");
    const { perAccount, recent } = accountRunStats([
      { id: "r2", startedAt: t1, planAgent: "claude:opus", workAgent: "codex:gpt-5", reviewAgent: "claude", accounts: { plan: "a", work: "c1", review: "a" } },
      { id: "r1", startedAt: t0, planAgent: "claude", workAgent: "codex", reviewAgent: "claude", accounts: { work: "c2" } },
    ]);
    expect(perAccount.get("claude\u0000a")).toEqual({ runs: 2, lastRunAt: t1.toISOString() });
    expect(perAccount.get("codex\u0000c1")).toEqual({ runs: 1, lastRunAt: t1.toISOString() });
    expect(perAccount.get("codex\u0000c2")).toEqual({ runs: 1, lastRunAt: t0.toISOString() });
    expect(recent.get("codex")?.map((r) => r.runId)).toEqual(["r2", "r1"]);
  });
});
