import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AgentTokens = { inputTokens: number; outputTokens: number; totalTokens: number; sessions: number };
export type AgentInfo = {
  agent: "claude" | "codex" | "antigravity";
  connected: boolean; account: string | null; plan?: string | null; authMode: string; note?: string;
  tokens: AgentTokens | null;
};

function decodeJwtEmail(jwt: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString());
    return typeof payload.email === "string" ? payload.email : null;
  } catch { return null; }
}

function* walkJsonl(dir: string): Generator<string> {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const path = join(dir, name);
    let st; try { st = statSync(path); } catch { continue; }
    if (st.isDirectory()) yield* walkJsonl(path);
    else if (name.endsWith(".jsonl")) yield path;
  }
}

// Claude: sum per-turn usage deltas across ~/.claude/projects.
function sumClaudeTokens(sinceDays: number, homeDir: string): AgentTokens {
  const dir = join(homeDir, ".claude", "projects");
  const cutoff = Date.now() - sinceDays * 24 * 3600 * 1000;
  const t: AgentTokens = { inputTokens: 0, outputTokens: 0, totalTokens: 0, sessions: 0 };
  for (const path of walkJsonl(dir)) {
    try {
      if (statSync(path).mtimeMs < cutoff) continue;
      let hit = false;
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        let d: any; try { d = JSON.parse(line); } catch { continue; }
        const u = d?.message?.usage;
        if (!u) continue;
        t.inputTokens += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        t.outputTokens += u.output_tokens || 0;
        hit = true;
      }
      if (hit) t.sessions++;
    } catch { /* skip file */ }
  }
  t.totalTokens = t.inputTokens + t.outputTokens;
  return t;
}

// Codex: cumulative total per rollout — take the MAX, sum across files.
function sumCodexTokens(sinceDays: number, homeDir: string): AgentTokens {
  const dir = join(homeDir, ".codex", "sessions");
  const cutoff = Date.now() - sinceDays * 24 * 3600 * 1000;
  const t: AgentTokens = { inputTokens: 0, outputTokens: 0, totalTokens: 0, sessions: 0 };
  for (const path of walkJsonl(dir)) {
    try {
      if (statSync(path).mtimeMs < cutoff) continue;
      let max = { input: 0, output: 0, total: 0 };
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        let d: any; try { d = JSON.parse(line); } catch { continue; }
        const tu = d?.payload?.type === "token_count" ? d.payload.info?.total_token_usage : null;
        if (tu && (tu.total_tokens || 0) > max.total) max = { input: tu.input_tokens || 0, output: tu.output_tokens || 0, total: tu.total_tokens || 0 };
      }
      if (max.total > 0) { t.inputTokens += max.input; t.outputTokens += max.output; t.totalTokens += max.total; t.sessions++; }
    } catch { /* skip */ }
  }
  return t;
}

function readClaudeAccount(homeDir: string): AgentInfo {
  const base: AgentInfo = { agent: "claude", connected: false, account: null, plan: null, authMode: "oauth", tokens: null };
  try {
    const j = JSON.parse(readFileSync(join(homeDir, ".claude.json"), "utf8"));
    const a = j.oauthAccount;
    if (a?.emailAddress) return { ...base, connected: true, account: a.emailAddress, plan: a.seatTier ?? null };
  } catch { /* not connected */ }
  return base;
}

function readCodexAccount(homeDir: string): AgentInfo {
  const base: AgentInfo = { agent: "codex", connected: false, account: null, authMode: "unknown", tokens: null };
  try {
    const j = JSON.parse(readFileSync(join(homeDir, ".codex", "auth.json"), "utf8"));
    const email = j.tokens?.id_token ? decodeJwtEmail(j.tokens.id_token) : null;
    return { ...base, connected: !!email || !!j.OPENAI_API_KEY, account: email, authMode: j.auth_mode ?? "unknown" };
  } catch { return base; }
}

function readAntigravityAccount(): AgentInfo {
  const base: AgentInfo = { agent: "antigravity", connected: false, account: null, authMode: "oauth", note: "account not exposed locally", tokens: null };
  try {
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
    const dbPath = join(process.env.APPDATA ?? "", "Antigravity IDE", "User", "globalStorage", "state.vscdb");
    if (!existsSync(dbPath)) return base;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("select value from ItemTable where key='antigravityUnifiedStateSync.oauthToken'").get() as { value: string } | undefined;
      const signedIn = !!row && Buffer.from(String(row.value).replace(/[^A-Za-z0-9+/=]/g, ""), "base64").toString("latin1").includes("signedIn");
      return { ...base, connected: signedIn };
    } finally { db.close(); }
  } catch { return base; }
}

export async function getAgents(sinceDays: number, homeDir = homedir()): Promise<{ sinceDays: number; agents: AgentInfo[] }> {
  const days = Number.isFinite(sinceDays) && sinceDays >= 0 ? sinceDays : 7;
  const claude = readClaudeAccount(homeDir); claude.tokens = sumClaudeTokens(days, homeDir);
  const codex = readCodexAccount(homeDir); codex.tokens = sumCodexTokens(days, homeDir);
  const antigravity = readAntigravityAccount();
  return { sinceDays: days, agents: [claude, codex, antigravity] };
}
