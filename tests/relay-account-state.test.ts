import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, cpSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { settings } from "../src/db/schema.js";
import { readAccountState, markExhausted, markUsed, stateKey, resolveCooldownMs } from "../src/relay/account-state.js";
import { availableAccount, chooseAccount } from "../src/relay/accounts.js";
import { runAgent } from "../src/relay/dispatch.js";
import type { RelayAgent } from "../src/relay/config.js";
import { withSetting } from "./helpers/settings.js";

describe("relay-account-state", () => {
  const now = new Date(2026, 9, 24, 12, 0, 0);
  let bin: string;
  let dirA: string;
  let dirB: string;

  beforeAll(() => {
    bin = process.execPath;
    const ext = process.platform === "win32" ? ".exe" : "";
    const dest = join(tmpdir(), `codex-test-${Date.now()}${ext}`);
    cpSync(bin, dest);
    if (process.platform !== "win32") chmodSync(dest, 0o755);
    bin = dest;

    dirA = mkdtempSync(join(tmpdir(), "account-a-"));
    dirB = mkdtempSync(join(tmpdir(), "account-b-"));
  });

  it("persistence", async () => {
    const resetAt = new Date(now.getTime() + 7200_000);
    const acct = { id: "a", label: "A", configDir: dirA, priority: 1 };
    await markExhausted(acct, resetAt, "x".repeat(600), now);
    const state = await readAccountState(dirA);
    expect(state.exhaustedUntil).toBe(resetAt.toISOString());
    expect(state.lastError).toHaveLength(500);

    const rows = await db.select().from(settings).where(eq(settings.key, stateKey(dirA)));
    expect(rows.length).toBe(1);
  });

  it("default cool-down", async () => {
    const acct = { id: "a", label: "A", configDir: dirA, priority: 1 };
    const until = await markExhausted(acct, undefined, "e", now);
    expect(until.getTime()).toBe(now.getTime() + 3_600_000);
  });

  it("custom cool-down", async () => {
    await withSetting("forge.accountCooldownMs", "60000", async () => {
      const acct = { id: "a", label: "A", configDir: dirA, priority: 1 };
      const until = await markExhausted(acct, undefined, "e", now);
      expect(until.getTime()).toBe(now.getTime() + 60_000);
    });
  });

  it("resolveCooldownMs", () => {
    expect(resolveCooldownMs("abc")).toBe(3_600_000);
    expect(resolveCooldownMs("0")).toBe(3_600_000);
    expect(resolveCooldownMs("5000")).toBe(5000);
  });

  it("choice order: skip exhausted", async () => {
    const acctA = { id: "a", label: "A", configDir: dirA, priority: 1 };
    const acctB = { id: "b", label: "B", configDir: dirB, priority: 2 };
    const agent: RelayAgent = {
      cmd: ["echo"], roles: ["work"], accounts: [acctA, acctB],
    };

    await markExhausted(acctA, new Date(now.getTime() + 3600_000), "e", now);
    const { account } = await availableAccount(agent, now);
    expect(account?.id).toBe("b");
  });

  it("choice order: back to primary", async () => {
    const acctA = { id: "a", label: "A", configDir: dirA, priority: 1 };
    const acctB = { id: "b", label: "B", configDir: dirB, priority: 2 };
    const agent: RelayAgent = {
      cmd: ["echo"], roles: ["work"], accounts: [acctA, acctB],
    };

    await markExhausted(acctA, new Date(now.getTime() - 3600_000), "e", now);
    const { account } = await availableAccount(agent, now);
    expect(account?.id).toBe("a");
  });

  it("all exhausted", async () => {
    const acctA = { id: "a", label: "A", configDir: dirA, priority: 1 };
    const acctB = { id: "b", label: "B", configDir: dirB, priority: 2 };
    const agent: RelayAgent = {
      cmd: ["echo"], roles: ["work"], accounts: [acctA, acctB],
    };

    const untilA = new Date(now.getTime() + 7200_000);
    const untilB = new Date(now.getTime() + 3600_000);
    await markExhausted(acctA, untilA, "e", now);
    await markExhausted(acctB, untilB, "e", now);

    const { account, allExhaustedUntil } = await availableAccount(agent, now);
    expect(account).toBeUndefined();
    expect(allExhaustedUntil).toEqual(untilB);
  });

  it("all exhausted: disabled account", async () => {
    const acctA = { id: "a", label: "A", configDir: dirA, priority: 1, disabled: true };
    const acctB = { id: "b", label: "B", configDir: dirB, priority: 2 };
    const agent: RelayAgent = {
      cmd: ["echo"], roles: ["work"], accounts: [acctA, acctB],
    };

    const untilB = new Date(now.getTime() + 3600_000);
    await markExhausted(acctB, untilB, "e", now);

    const { account, allExhaustedUntil } = await availableAccount(agent, now);
    expect(account).toBeUndefined();
    expect(allExhaustedUntil).toEqual(untilB);
  });

  it("chooseAccount writes lastUsed", async () => {
    const acctA = { id: "a", label: "A", configDir: dirA, priority: 1 };
    const acctB = { id: "b", label: "B", configDir: dirB, priority: 2 };
    const agent: RelayAgent = {
      cmd: ["echo"], roles: ["work"], accounts: [acctA, acctB],
    };

    await markExhausted(acctA, new Date(now.getTime() + 3600_000), "e", now);
    await chooseAccount(agent, now);

    const stateA = await readAccountState(dirA);
    const stateB = await readAccountState(dirB);
    expect(stateA.lastUsed).toBeUndefined();
    expect(stateB.lastUsed).toBe(now.toISOString());
  });

  it("runAgent: limit detection and retry", async () => {
    const FAKE_AGENT = "tests/fixtures/fake-agent.mjs";
    const agent: RelayAgent = {
      cmd: [bin, FAKE_AGENT, "{prompt}"],
      roles: ["work"],
      env: { FAKE_MODE: "work", FAKE_LIMIT_HOME: dirA },
      accounts: [
        { id: "a", label: "A", configDir: dirA, priority: 1 },
        { id: "b", label: "B", configDir: dirB, priority: 2 },
      ],
    };

    const res1 = await runAgent(agent, "test", tmpdir());
    expect(res1.ok).toBe(false);
    expect(res1.account).toBe("a");
    expect(res1.limit).toBeDefined();
    const until = Date.parse(res1.limit!.until);
    expect(Math.abs(until - Date.now() - 7200_000)).toBeLessThan(60_000);

    const res2 = await runAgent(agent, "test", tmpdir());
    expect(res2.ok).toBe(true);
    expect(res2.account).toBe("b");
  });

  it("runAgent: all exhausted message", async () => {
    const acctA = { id: "a", label: "A", configDir: dirA, priority: 1 };
    const acctB = { id: "b", label: "B", configDir: dirB, priority: 2 };

    const bReset = new Date(now.getTime() + 3600_000);
    await markExhausted(acctA, new Date(now.getTime() + 7200_000), "e", now);
    await markExhausted(acctB, bReset, "e", now);

    const FAKE_AGENT = "tests/fixtures/fake-agent.mjs";
    const agent: RelayAgent = {
      cmd: [bin, FAKE_AGENT, "{prompt}"],
      roles: ["work"],
      accounts: [acctA, acctB],
    };

    const res = await runAgent(agent, "test", tmpdir());
    expect(res.ok).toBe(false);
    expect(res.account).toBeUndefined();
    expect(res.output).toContain(`earliest reset ${bReset.toISOString()}`);
  });
});
