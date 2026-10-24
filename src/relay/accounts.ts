import { join } from "node:path";
import type { RelayAgent, RelayAccount } from "./config.js";
import { binBasename } from "./doctor.js";

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
// ponytail: ticket 2/3 adds skipping accounts marked exhausted here.
export function pickAccount(agent: RelayAgent): RelayAccount | undefined {
  return (agent.accounts ?? []).filter((a) => !a.disabled).sort((a, b) => a.priority - b.priority)[0];
}

// Env to lay over agent.env for this run, plus the chosen account id. Empty when
// the lane has no usable account: the lane then runs exactly as before.
export function accountEnv(agent: RelayAgent): { account?: string; env: Record<string, string> } {
  const acct = pickAccount(agent);
  const toEnv = acct ? ACCOUNT_ENV[laneKind(agent) ?? ""] : undefined;
  return acct && toEnv ? { account: acct.id, env: toEnv(acct.configDir) } : { env: {} };
}
