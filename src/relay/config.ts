import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type RelayAgent = { cmd: string[]; roles: string[]; timeoutMs?: number };
export type RelayConfig = {
  workdir: string; apiKey?: string; baseUrl?: string; pollMs?: number;
  agents: Record<string, RelayAgent>;
};

const SAMPLE_CONFIG = `{
  "workdir": "D:/Github/myproject",
  "agents": {
    "fable": { "cmd": ["claude", "-p", "{promptFile}"], "roles": ["plan", "review"] },
    "codex": { "cmd": ["codex", "exec", "-C", "{workdir}", "{prompt}"], "roles": ["work"] }
  }
}`;

// Config lives in a local 0600 file, never the settings DB (see spec: any admin
// API key could otherwise rewrite executable command templates into shell access).
export function loadRelayConfig(path?: string): RelayConfig {
  const configPath = path ?? join(homedir(), ".vibeops", "relay.json");
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    throw new Error(
      `relay config not found at ${configPath}. Create it, e.g.:\n${SAMPLE_CONFIG}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`relay config at ${configPath} is not valid JSON: ${(e as Error).message}`);
  }
  const cfg = parsed as Record<string, unknown>;
  if (!cfg || typeof cfg !== "object" || typeof cfg.workdir !== "string" || !cfg.workdir) {
    throw new Error(`relay config at ${configPath} must include a "workdir" string`);
  }
  if (!cfg.agents || typeof cfg.agents !== "object") {
    throw new Error(`relay config at ${configPath} must include an "agents" object`);
  }
  for (const [name, agent] of Object.entries(cfg.agents as Record<string, unknown>)) {
    const a = agent as Record<string, unknown>;
    if (!Array.isArray(a.cmd) || a.cmd.length === 0 || !a.cmd.every((c) => typeof c === "string")) {
      throw new Error(`relay config agent "${name}" must have a non-empty cmd string array`);
    }
    if (!Array.isArray(a.roles) || !a.roles.every((r) => typeof r === "string")) {
      throw new Error(`relay config agent "${name}" must have a roles string array`);
    }
  }
  return cfg as unknown as RelayConfig;
}
