import { execFile } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { vibeopsHome } from "../runtime/home.js";
import type { RelayAgent, RelayAccount } from "./config.js";
import { ACCOUNT_ENV, laneKind } from "./accounts.js";
import { markLogin } from "./account-state.js";
import { winCommand } from "./win-bin.js";
import { redactSecrets } from "../forge/redact.js";

const execFileAsync = promisify(execFile);
const LOGIN_PROBE_TIMEOUT_MS = 60_000;
const ROLES = ["plan", "work", "review"] as const;
const RECENT_PER_LANE = 5;

export function accountsRoot(): string {
  return join(vibeopsHome(), ".vibeops", "accounts");
}

export function defaultAccountDir(agentName: string, id: string): string {
  return join(accountsRoot(), agentName, id);
}

export function insideAccountsRoot(dir: string): boolean {
  return resolve(dir).startsWith(resolve(accountsRoot()) + sep);
}

const LOGIN_STEP: Record<string, { args: string; then?: string }> = {
  claude: { args: "", then: "type /login" },
  "claude-sdk": { args: "", then: "type /login" },
  codex: { args: " login" },
  agy: { args: "", then: "sign in when asked" },
};

// The exact shell line that logs a CLI into one account folder (PowerShell on win32).
export function loginCommand(kind: string, dir: string, platform: NodeJS.Platform = process.platform): { command: string; then?: string } | undefined {
  const toEnv = ACCOUNT_ENV[kind];
  const step = LOGIN_STEP[kind];
  if (!toEnv || !step) return undefined;
  const env = Object.entries(toEnv(dir));
  const prefix = platform === "win32"
    ? env.map(([k, v]) => `$env:${k}="${v}"; `).join("")
    : env.map(([k, v]) => `${k}="${v}" `).join("");
  const bin = kind === "claude-sdk" ? "claude" : kind;
  return { command: `${prefix}${bin}${step.args}`, ...(step.then ? { then: step.then } : {}) };
}

// No-cost probes: one haiku turn for claude, the stored login for codex. agy has no verified probe.
const LOGIN_PROBE: Record<string, string[]> = {
  claude: ["--model", "haiku", "-p", "reply ok"],
  "claude-sdk": ["--model", "haiku", "-p", "reply ok"],
  codex: ["login", "status"],
};

export function canCheckLogin(kind?: string): boolean {
  return !!kind && kind in LOGIN_PROBE;
}

export async function checkLogin(agent: RelayAgent, acct: RelayAccount, now = new Date()): Promise<{ ok: boolean; error?: string }> {
  const kind = laneKind(agent) ?? "";
  const probe = LOGIN_PROBE[kind];
  const toEnv = ACCOUNT_ENV[kind];
  if (!probe || !toEnv) throw new Error(`login check is not available for lane kind "${kind}"`);
  let res: { ok: boolean; error?: string };
  try {
    // claude-sdk spawns no binary of its own; it shares the claude CLI's login.
    const { file, args, verbatim } = winCommand(kind === "claude-sdk" ? "claude" : agent.cmd[0], probe);
    await execFileAsync(file, args, {
      timeout: LOGIN_PROBE_TIMEOUT_MS, windowsHide: true, windowsVerbatimArguments: verbatim,
      env: { ...process.env, ...agent.env, ...toEnv(acct.configDir) },
    });
    res = { ok: true };
  } catch (e) {
    const err = e as Error & { stderr?: string; stdout?: string };
    res = { ok: false, error: redactSecrets((err.stderr || err.stdout || err.message || "").trim().slice(-300)) };
  }
  await markLogin(acct.configDir, res.ok, now);
  return res;
}

export function mainClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

// Same agent behaviour on a new Claude login; never overwrites a file already there.
export function copyClaudeSettings(dir: string): string[] {
  const copied: string[] = [];
  for (const f of ["CLAUDE.md", "settings.json"]) {
    const src = join(mainClaudeDir(), f);
    const dst = join(dir, f);
    if (existsSync(src) && !existsSync(dst)) {
      copyFileSync(src, dst);
      copied.push(f);
    }
  }
  return copied;
}

export type RunRow = { id: string; startedAt: Date; planAgent: string; workAgent: string; reviewAgent: string; accounts: { plan?: string; work?: string; review?: string } | null };
export type RecentRun = { runId: string; role: (typeof ROLES)[number]; account: string; startedAt: string };

// rows newest first. Keys: `${agent}\u0000${accountId}` (ids are unique per lane only).
export function accountRunStats(rows: RunRow[]): { perAccount: Map<string, { runs: number; lastRunAt: string }>; recent: Map<string, RecentRun[]> } {
  const perAccount = new Map<string, { runs: number; lastRunAt: string }>();
  const recent = new Map<string, RecentRun[]>();
  for (const r of rows) {
    for (const role of ROLES) {
      const account = r.accounts?.[role];
      if (!account) continue;
      // forge_runs stores "agent:model" (runs.ts composite()).
      const agent = (role === "plan" ? r.planAgent : role === "work" ? r.workAgent : r.reviewAgent).split(":")[0];
      const at = r.startedAt.toISOString();
      const key = `${agent}\u0000${account}`;
      const s = perAccount.get(key);
      if (s) s.runs++;
      else perAccount.set(key, { runs: 1, lastRunAt: at });
      const list = recent.get(agent) ?? [];
      if (list.length < RECENT_PER_LANE) {
        list.push({ runId: r.id, role, account, startedAt: at });
        recent.set(agent, list);
      }
    }
  }
  return { perAccount, recent };
}
