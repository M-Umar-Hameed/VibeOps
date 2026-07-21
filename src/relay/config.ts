import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { substituteCmd } from "./invoke.js";

export type ModelTier = "free" | "cheap" | "expensive";
export type RelayModel = { name: string; tier: ModelTier; quality: number };
export type RelayAgent = { cmd: string[]; roles: string[]; timeoutMs?: number; models?: RelayModel[]; env?: Record<string, string> };
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
    if (a.env !== undefined) {
      if (typeof a.env !== "object" || a.env === null || Array.isArray(a.env)) {
        throw new Error(`relay config agent "${name}" env must be an object of string values`);
      }
      for (const [k, v] of Object.entries(a.env)) {
        if (typeof v !== "string") {
          throw new Error(`relay config agent "${name}" env value "${k}" must be a string`);
        }
      }
    }
    if (a.models !== undefined) {
      if (!Array.isArray(a.models) || a.models.length === 0) {
        throw new Error(`relay config agent "${name}" models must be a non-empty array if present`);
      }
      for (const m of a.models as unknown[]) {
        const model = m as Record<string, unknown>;
        if (typeof model.name !== "string" || !model.name) {
          throw new Error(`relay config agent "${name}" has a model with an invalid name`);
        }
        if (model.tier !== "free" && model.tier !== "cheap" && model.tier !== "expensive") {
          throw new Error(`relay config agent "${name}" model "${model.name}" has an invalid tier`);
        }
        if (!Number.isInteger(model.quality) || (model.quality as number) < 1 || (model.quality as number) > 5) {
          throw new Error(`relay config agent "${name}" model "${model.name}" quality must be an integer 1-5`);
        }
      }
    }
  }
  return cfg as unknown as RelayConfig;
}

// Resolves {model} in an agent's cmd before spawn. Requesting a model the cmd
// can't use (no {model} placeholder or no models list) or that isn't in the
// agent's list is a config/request mismatch -> throw (mapped to 400 upstream).
export function resolveCmd(agent: RelayAgent, model?: string): string[] {
  const hasModelVar = agent.cmd.some((p) => p.includes("{model}"));
  if (model !== undefined) {
    if (!hasModelVar || !agent.models?.length) {
      throw new Error(`agent does not support model selection`);
    }
    if (!agent.models.some((m) => m.name === model)) {
      throw new Error(`unknown model "${model}" for this agent`);
    }
    return substituteCmd(agent.cmd, { model });
  }
  if (agent.models?.length) {
    return substituteCmd(agent.cmd, { model: agent.models[0].name });
  }
  return agent.cmd;
}
