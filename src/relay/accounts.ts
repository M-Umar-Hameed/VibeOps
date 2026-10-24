import { join } from "node:path";
import type { RelayAgent, RelayAccount } from "./config.js";
import { binBasename } from "./doctor.js";
import type { AgentResult } from "./invoke.js";
import { detectLimit } from "./limits.js";
import { readAccountState, markExhausted, markUsed } from "./account-state.js";

// How each subscription CLI is pointed at one logged-in account folder.
// agy: no config-dir switch was verified, so the account folder stands in for the
// user profile (home + roaming/local app data). See docs/AGENT_CLIS.md "Accounts".
export const ACCOUNT_ENV: Record<string, (dir: string) => Record<string, string>> = {
  claude: (dir) => ({ CLAUDE_CONFIG_DIR: dir }),
  "claude-sdk": (dir) => ({ CLAUDE_CONFIG_DIR: dir }),
  codex: (dir) => ({ CODEX_HOME: dir }),
  agy: (dir) => ({ USERPROFILE: dir, HOME: dir, APPDATA: join(dir, "AppData", "Roaming"), LOCALAPPDATA: join(dir, "AppData", "Local") }),
};

export function laneKind(agent: Pick<RelayAgent, "type" | "cmd">): string | undefined {
  if (agent.type === "sdk") return "claude-sdk";
  if (agent.type === "http" || !Array.isArray(agent.cmd) || typeof agent.cmd[0] !== "string") return undefined;
  return binBasename(agent.cmd[0]).toLowerCase();
}

// Lowest priority number wins; ties keep relay.json order (sort is stable).
// `exhausted` holds configDirs whose usage limit has not reset yet.
export function pickAccount(agent: RelayAgent, exhausted: ReadonlySet<string> = new Set()): RelayAccount | undefined {
  return (agent.accounts ?? []).filter((a) => !a.disabled && !exhausted.has(a.configDir)).sort((a, b) => a.priority - b.priority)[0];
}

export function accountEnv(agent: RelayAgent, exhausted?: ReadonlySet<string>): { account?: string; env: Record<string, string> } {
  const acct = pickAccount(agent, exhausted);
  const toEnv = acct ? ACCOUNT_ENV[laneKind(agent) ?? ""] : undefined;
  return acct && toEnv ? { account: acct.id, env: toEnv(acct.configDir) } : { env: {} };
}

// Read-only: stored limit state of each enabled account. allExhaustedUntil is set
// when every enabled account is still at its limit (the earliest reset).
export async function availableAccount(agent: RelayAgent, now = new Date()): Promise<{ account?: RelayAccount; exhausted: Set<string>; allExhaustedUntil?: Date }> {
  const usable = (agent.accounts ?? []).filter((a) => !a.disabled);
  const exhausted = new Set<string>();
  let earliest: number | undefined;
  for (const a of usable) {
    const until = Date.parse((await readAccountState(a.configDir)).exhaustedUntil ?? "");
    if (until > now.getTime()) { exhausted.add(a.configDir); earliest = Math.min(earliest ?? until, until); }
  }
  const account = pickAccount(agent, exhausted);
  return { account, exhausted, ...(usable.length && !account && earliest !== undefined ? { allExhaustedUntil: new Date(earliest) } : {}) };
}

// Account for one agent run: env to lay over agent.env, or allExhaustedUntil.
export async function chooseAccount(agent: RelayAgent, now = new Date()): Promise<{ account?: string; env: Record<string, string>; allExhaustedUntil?: Date }> {
  const { account, exhausted, allExhaustedUntil } = await availableAccount(agent, now);
  if (allExhaustedUntil) return { env: {}, allExhaustedUntil };
  if (account) await markUsed(account, now);
  return accountEnv(agent, exhausted);
}

export function allExhaustedResult(until: Date, onData?: (chunk: string) => void): AgentResult {
  const output = `\n[forge: usage limit reached on every account of this lane; earliest reset ${until.toISOString()}]\n`;
  onData?.(output);
  return { ok: false, output };
}

// After a run: tag the account; on a usage-limit failure store it as exhausted.
export async function settleAccountResult(agent: RelayAgent, res: AgentResult, account?: string, now = new Date()): Promise<AgentResult> {
  if (!account) return res;
  const acct = agent.accounts?.find((a) => a.id === account);
  const hit = !res.ok && acct ? detectLimit(laneKind(agent), res.output, now) : undefined;
  if (!hit || !acct) return { ...res, account };
  const until = await markExhausted(acct, hit.resetAt, res.output, now);
  return { ...res, account, limit: { until: until.toISOString() } };
}
