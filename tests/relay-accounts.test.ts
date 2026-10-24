import { beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, chmodSync, copyFileSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateRelayConfig } from "../src/relay/config.js";
import { laneKind, pickAccount, accountEnv } from "../src/relay/accounts.js";
import { runAgent } from "../src/relay/invoke.js";
import type { RelayAgent } from "../src/relay/config.js";

describe("relay-accounts", () => {
  let workdir: string;
  let acctRoot: string;
  let bin: string;

  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), "acct-wd-"));
    acctRoot = mkdtempSync(join(tmpdir(), "acct-dirs-"));
    const binRoot = mkdtempSync(join(tmpdir(), "acct-bin-"));
    bin = join(binRoot, process.platform === "win32" ? "codex.exe" : "codex");
    copyFileSync(process.execPath, bin);
    chmodSync(bin, 0o755);
  });

  describe("validation", () => {
    test("valid claude lane with 2 accounts passes", () => {
      const agent = {
        cmd: ["claude", "-p", "{prompt}"],
        roles: ["plan"],
        accounts: [
          { id: "a", label: "Account A", configDir: join(acctRoot, "a"), priority: 1 },
          { id: "b", label: "Account B", configDir: join(acctRoot, "b"), priority: 2 },
        ],
      };
      expect(() => validateRelayConfig({ workdir, agents: { x: agent } }, "t")).not.toThrow();
    });

    test("duplicate id throws", () => {
      const agent = {
        cmd: ["claude", "-p", "{prompt}"],
        roles: ["plan"],
        accounts: [
          { id: "a", label: "A", configDir: join(acctRoot, "a"), priority: 1 },
          { id: "a", label: "B", configDir: join(acctRoot, "b"), priority: 2 },
        ],
      };
      expect(() => validateRelayConfig({ workdir, agents: { x: agent } }, "t")).toThrow(/used twice/);
    });

    test("empty configDir throws", () => {
      const agent = {
        cmd: ["claude", "-p", "{prompt}"],
        roles: ["plan"],
        accounts: [
          { id: "a", label: "A", configDir: "  ", priority: 1 },
        ],
      };
      expect(() => validateRelayConfig({ workdir, agents: { x: agent } }, "t")).toThrow(/non-empty configDir/);
    });

    test("non-integer priority throws", () => {
      const agent = {
        cmd: ["claude", "-p", "{prompt}"],
        roles: ["plan"],
        accounts: [
          { id: "a", label: "A", configDir: join(acctRoot, "a"), priority: 1.5 },
        ],
      };
      expect(() => validateRelayConfig({ workdir, agents: { x: agent } }, "t")).toThrow(/priority must be an integer/);
    });

    test("unsupported lane kind throws", () => {
      const agent = {
        cmd: ["kimi", "{prompt}"],
        roles: ["plan"],
        accounts: [
          { id: "a", label: "A", configDir: join(acctRoot, "a"), priority: 1 },
        ],
      };
      expect(() => validateRelayConfig({ workdir, agents: { x: agent } }, "t")).toThrow(/not supported for this lane kind/);
    });

    test("http lane with accounts throws", () => {
      const agent = {
        type: "http" as const,
        baseUrl: "https://example.com",
        keySetting: "test",
        roles: ["plan"],
        accounts: [
          { id: "a", label: "A", configDir: join(acctRoot, "a"), priority: 1 },
        ],
      };
      expect(() => validateRelayConfig({ workdir, agents: { x: agent } }, "t")).toThrow(/not supported/);
    });

    test("configDir inside workdir throws", () => {
      const agent = {
        cmd: ["claude", "-p", "{prompt}"],
        roles: ["plan"],
        accounts: [
          { id: "a", label: "A", configDir: join(workdir, "acct"), priority: 1 },
        ],
      };
      expect(() => validateRelayConfig({ workdir, agents: { x: agent } }, "t")).toThrow(/outside the workdir/);
    });

    test("invalid disabled type throws", () => {
      const agent = {
        cmd: ["claude", "-p", "{prompt}"],
        roles: ["plan"],
        accounts: [
          { id: "a", label: "A", configDir: join(acctRoot, "a"), priority: 1, disabled: "yes" as unknown as boolean },
        ],
      };
      expect(() => validateRelayConfig({ workdir, agents: { x: agent } }, "t")).toThrow(/disabled must be a boolean/);
    });

    test("empty accounts array throws", () => {
      const agent = {
        cmd: ["claude", "-p", "{prompt}"],
        roles: ["plan"],
        accounts: [],
      };
      expect(() => validateRelayConfig({ workdir, agents: { x: agent } }, "t")).toThrow(/non-empty array/);
    });

    test("hand-made lane with env CLAUDE_CONFIG_DIR passes", () => {
      const agent = {
        cmd: ["claude", "-p", "{prompt}"],
        roles: ["plan"],
        env: { CLAUDE_CONFIG_DIR: join(acctRoot, "b") },
      };
      expect(() => validateRelayConfig({ workdir, agents: { x: agent } }, "t")).not.toThrow();
      const acct = accountEnv(agent as RelayAgent);
      expect(acct).toEqual({ env: {} });
    });
  });

  describe("laneKind", () => {
    test("sdk type returns claude-sdk", () => {
      expect(laneKind({ type: "sdk" } as RelayAgent)).toBe("claude-sdk");
    });

    test("cmd with Codex.exe returns codex", () => {
      expect(laneKind({ cmd: ["C:\\x\\Codex.exe"] } as RelayAgent)).toBe("codex");
    });

    test("cmd with agy returns agy", () => {
      expect(laneKind({ cmd: ["agy"] } as RelayAgent)).toBe("agy");
    });

    test("http type returns undefined", () => {
      expect(laneKind({ type: "http" } as RelayAgent)).toBeUndefined();
    });
  });

  describe("pickAccount", () => {
    test("selects lowest priority", () => {
      const agent = {
        accounts: [
          { id: "c", label: "C", configDir: "/c", priority: 3 },
          { id: "a", label: "A", configDir: "/a", priority: 1 },
          { id: "b", label: "B", configDir: "/b", priority: 2 },
        ],
      } as RelayAgent;
      expect(pickAccount(agent)?.id).toBe("a");
    });

    test("tie at same priority uses file order", () => {
      const agent = {
        accounts: [
          { id: "a", label: "A", configDir: "/a", priority: 1 },
          { id: "b", label: "B", configDir: "/b", priority: 1 },
        ],
      } as RelayAgent;
      expect(pickAccount(agent)?.id).toBe("a");
    });

    test("skips disabled accounts", () => {
      const agent = {
        accounts: [
          { id: "a", label: "A", configDir: "/a", priority: 1, disabled: true },
          { id: "b", label: "B", configDir: "/b", priority: 2 },
        ],
      } as RelayAgent;
      expect(pickAccount(agent)?.id).toBe("b");
    });

    test("all disabled returns undefined", () => {
      const agent = {
        accounts: [
          { id: "a", label: "A", configDir: "/a", priority: 1, disabled: true },
        ],
      } as RelayAgent;
      expect(pickAccount(agent)).toBeUndefined();
    });

    test("no accounts returns undefined", () => {
      const agent = {} as RelayAgent;
      expect(pickAccount(agent)).toBeUndefined();
    });

    test("input array is not reordered", () => {
      const accounts = [
        { id: "c", label: "C", configDir: "/c", priority: 3 },
        { id: "a", label: "A", configDir: "/a", priority: 1 },
        { id: "b", label: "B", configDir: "/b", priority: 2 },
      ];
      const agent = { accounts } as RelayAgent;
      pickAccount(agent);
      expect(accounts.map((a) => a.id)).toEqual(["c", "a", "b"]);
    });
  });

  describe("accountEnv per provider", () => {
    test("claude", () => {
      const agent = {
        cmd: ["claude", "-p"],
        accounts: [{ id: "a", label: "A", configDir: "/D", priority: 1 }],
      } as RelayAgent;
      const result = accountEnv(agent);
      expect(result).toEqual({ account: "a", env: { CLAUDE_CONFIG_DIR: "/D" } });
    });

    test("claude-sdk", () => {
      const agent = {
        type: "sdk" as const,
        accounts: [{ id: "a", label: "A", configDir: "/D", priority: 1 }],
      } as RelayAgent;
      const result = accountEnv(agent);
      expect(result).toEqual({ account: "a", env: { CLAUDE_CONFIG_DIR: "/D" } });
    });

    test("codex", () => {
      const agent = {
        cmd: ["codex"],
        accounts: [{ id: "a", label: "A", configDir: "/D", priority: 1 }],
      } as RelayAgent;
      const result = accountEnv(agent);
      expect(result).toEqual({ account: "a", env: { CODEX_HOME: "/D" } });
    });

    test("agy", () => {
      const agent = {
        cmd: ["agy"],
        accounts: [{ id: "a", label: "A", configDir: "/D", priority: 1 }],
      } as RelayAgent;
      const result = accountEnv(agent);
      expect(result).toEqual({
        account: "a",
        env: {
          USERPROFILE: "/D",
          HOME: "/D",
          APPDATA: join("/D", "AppData", "Roaming"),
          LOCALAPPDATA: join("/D", "AppData", "Local"),
        },
      });
    });
  });

  describe("runAgent env merge", () => {
    test("account env overrides agent.env", async () => {
      const dirA = join(acctRoot, "a");
      const dirB = join(acctRoot, "b");
      const agent: RelayAgent = {
        cmd: [bin, "-e", "console.log('CH='+process.env.CODEX_HOME+' X='+process.env.X)"],
        roles: [],
        env: { X: "1", CODEX_HOME: "from-env" },
        accounts: [
          { id: "b", label: "B", configDir: dirB, priority: 2 },
          { id: "a", label: "A", configDir: dirA, priority: 1 },
        ],
      };
      const res = await runAgent(agent, "", workdir);
      expect(res.ok).toBe(true);
      expect(res.output).toContain(`CH=${dirA}`);
      expect(res.output).toContain("X=1");
      expect(res.account).toBe("a");
    }, 60000);

    test("no accounts keeps agent.env", async () => {
      const agent: RelayAgent = {
        cmd: [bin, "-e", "console.log('CH='+process.env.CODEX_HOME+' X='+process.env.X)"],
        roles: [],
        env: { X: "1", CODEX_HOME: "from-env" },
      };
      const res = await runAgent(agent, "", workdir);
      expect(res.ok).toBe(true);
      expect(res.output).toContain("CH=from-env");
      expect(res.account).toBeUndefined();
    }, 60000);
  });
});
