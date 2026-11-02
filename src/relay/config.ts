import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { substituteCmd } from "./invoke.js";
import { registerEnvSecrets } from "../forge/redact.js";
import { ACCOUNT_ENV, laneKind } from "./accounts.js";
import { vibeopsHome } from "../runtime/home.js";

export type ModelTier = "free" | "cheap" | "expensive";
export type RelayModel = { name: string; tier: ModelTier; quality: number };
// http lanes are chat-only model providers (e.g. OpenRouter): baseUrl is an
// OpenAI-compatible API root, keySetting names the settings-table key holding
// the user API key. cmd is unused for them.
// write is set at call time for a stage that must edit files (forge work, relay work); relay.json never sets it. addDirs is call-time only too (extra read folders for the walled claude reviewer). liftedRules is call-time only (risk rule ids a ticket lifted with ALLOW-COMMAND).
// How the initial prompt reaches the agent. Declared per agent rather than
// inferred from the cmd placeholders: inference silently picked argv for any
// config carrying {prompt}, and an oversized prompt then died at spawn with
// ENAMETOOLONG. Declaring it makes a mismatch a config error at load instead.
//   argv  - substituted into the launch command ({prompt})
//   file  - written to a temp file whose path is substituted ({promptFile})
//   stdin - written to the child's stdin after it starts (no placeholder)
export type PromptDelivery = "argv" | "file" | "stdin";
export const PROMPT_DELIVERIES: PromptDelivery[] = ["argv", "file", "stdin"];
export type RelayAccount = { id: string; label: string; configDir: string; priority: number; disabled?: boolean };
export type RelayAgent = { cmd: string[]; roles: string[]; timeoutMs?: number; models?: RelayModel[]; env?: Record<string, string>; type?: "cli" | "sdk" | "http"; mcp?: boolean; baseUrl?: string; keySetting?: string; write?: boolean; promptDelivery?: PromptDelivery; projectId?: string; addDirs?: string[]; liftedRules?: string[]; skillAllowlist?: string[]; accounts?: RelayAccount[]; usage?: "exact" };
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
    const bak = `${configPath}.bak`;
    if (existsSync(bak)) {
      try {
        const bakRaw = readFileSync(bak, "utf-8");
        const restored = validateRelayConfig(JSON.parse(bakRaw), configPath);
        writeFileSync(configPath, bakRaw, "utf-8");
        return restored;
      } catch {}
    }
    throw new Error(`relay config at ${configPath} is not valid JSON: ${(e as Error).message}`);
  }
  return validateRelayConfig(parsed, configPath);
}

// child is parent or inside it; case-insensitive on win32 like forge/sandbox.ts inside().
function under(child: string, parent: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const rel = relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// Split out of loadRelayConfig so the writers can check a config against the
// exact rules the reader enforces, instead of keeping a second copy of them in
// sync by hand -- a drifted copy is what let the Agents card write an sdk lane
// with plan/review roles and make the whole file unloadable.
export function validateRelayConfig(parsed: unknown, configPath: string): RelayConfig {
  const cfg = parsed as Record<string, unknown>;
  if (!cfg || typeof cfg !== "object" || typeof cfg.workdir !== "string" || !cfg.workdir) {
    throw new Error(`relay config at ${configPath} must include a "workdir" string`);
  }
  if (!cfg.agents || typeof cfg.agents !== "object") {
    throw new Error(`relay config at ${configPath} must include an "agents" object`);
  }
  for (const [name, agent] of Object.entries(cfg.agents as Record<string, unknown>)) {
    const a = agent as Record<string, unknown>;
    if (a.type !== undefined && a.type !== "cli" && a.type !== "sdk" && a.type !== "http") {
      throw new Error(`relay config agent "${name}" type must be "cli", "sdk", or "http"`);
    }
    if (a.type === "http") {
      if (typeof a.baseUrl !== "string" || !a.baseUrl.startsWith("https://")) {
        throw new Error(`relay config agent "${name}" of type http needs an https baseUrl`);
      }
      if (typeof a.keySetting !== "string" || !a.keySetting) {
        throw new Error(`relay config agent "${name}" of type http needs a keySetting naming the settings key that holds the API key`);
      }
      if (Array.isArray(a.roles) && a.roles.includes("work")) {
        // A chat/completions endpoint cannot edit files or run commands; letting
        // it claim work would wedge the forge queue. plan/review are text-in/
        // text-out, so a chat completion can serve them.
        throw new Error(`relay config agent "${name}" of type http cannot take the work role: a chat completion cannot edit files or run commands`);
      }
    }
    if (a.mcp !== undefined && typeof a.mcp !== "boolean") {
      throw new Error(`relay config agent "${name}" mcp must be a boolean`);
    }
    if (a.type !== "sdk" && a.type !== "http") {
      if (!Array.isArray(a.cmd) || a.cmd.length === 0 || !a.cmd.every((c) => typeof c === "string")) {
        throw new Error(`relay config agent "${name}" must have a non-empty cmd string array`);
      }
    }
    if (!Array.isArray(a.roles) || !a.roles.every((r) => typeof r === "string")) {
      throw new Error(`relay config agent "${name}" must have a roles string array`);
    }
    if (a.promptDelivery !== undefined) {
      if (typeof a.promptDelivery !== "string" || !PROMPT_DELIVERIES.includes(a.promptDelivery as PromptDelivery)) {
        throw new Error(`relay config agent "${name}" promptDelivery must be one of ${PROMPT_DELIVERIES.join(", ")}`);
      }
      // Catch the contradiction at load. A declared delivery that the cmd cannot
      // satisfy would otherwise fail at spawn, mid-run, with a confusing error.
      const cmd = Array.isArray(a.cmd) ? (a.cmd as string[]) : [];
      const has = (tok: string) => cmd.some((c) => typeof c === "string" && c.includes(tok));
      if (a.promptDelivery === "argv" && !has("{prompt}")) {
        throw new Error(`relay config agent "${name}" declares promptDelivery "argv" but its cmd has no {prompt}`);
      }
      if (a.promptDelivery === "file" && !has("{promptFile}")) {
        throw new Error(`relay config agent "${name}" declares promptDelivery "file" but its cmd has no {promptFile}`);
      }
      if (a.promptDelivery === "stdin" && (has("{prompt}") || has("{promptFile}"))) {
        throw new Error(`relay config agent "${name}" declares promptDelivery "stdin" but its cmd still substitutes the prompt`);
      }
    }
    if (a.type === "sdk" && a.roles.some((r) => r !== "work")) {
      throw new Error(`relay config agent "${name}" of type sdk can only have the "work" role in Phase 1`);
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
    if (a.skillAllowlist !== undefined && (!Array.isArray(a.skillAllowlist) || !a.skillAllowlist.every((n) => typeof n === "string"))) {
      throw new Error(`relay config agent "${name}" skillAllowlist must be an array of skill names`);
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
    if (a.usage !== undefined) {
      const k = a.type === "sdk" || a.type === "http" ? undefined : laneKind(a as RelayAgent);
      if (a.usage !== "exact" || (k !== "claude" && k !== "agy")) {
        throw new Error(`relay config agent "${name}" usage "exact" is only supported on claude and agy cli lanes`);
      }
    }
    if (a.accounts !== undefined) {
      const kind = laneKind(a as RelayAgent);
      if (!kind || !ACCOUNT_ENV[kind]) {
        throw new Error(`relay config agent "${name}" accounts are not supported for this lane kind (supported: ${Object.keys(ACCOUNT_ENV).join(", ")})`);
      }
      if (!Array.isArray(a.accounts) || a.accounts.length === 0) {
        throw new Error(`relay config agent "${name}" accounts must be a non-empty array if present`);
      }
      // Account folders hold login credentials: a work agent may write anywhere in
      // its sandbox, and sandboxes are copies of the workdir.
      const sandboxRoot = process.env.VIBEOPS_SANDBOX_ROOT ?? join(vibeopsHome(), ".vibeops", "sandbox");
      const ids = new Set<string>();
      for (const x of a.accounts as unknown[]) {
        const acc = x as Record<string, unknown>;
        if (typeof acc.id !== "string" || !acc.id) throw new Error(`relay config agent "${name}" has an account with an invalid id`);
        if (ids.has(acc.id)) throw new Error(`relay config agent "${name}" account id "${acc.id}" is used twice`);
        ids.add(acc.id);
        if (typeof acc.label !== "string") throw new Error(`relay config agent "${name}" account "${acc.id}" label must be a string`);
        if (typeof acc.configDir !== "string" || !acc.configDir.trim()) throw new Error(`relay config agent "${name}" account "${acc.id}" needs a non-empty configDir`);
        if (under(acc.configDir, cfg.workdir as string) || under(cfg.workdir as string, acc.configDir) || under(acc.configDir, sandboxRoot)) {
          throw new Error(`relay config agent "${name}" account "${acc.id}" configDir must be outside the workdir and the forge sandbox folder`);
        }
        if (!Number.isInteger(acc.priority)) throw new Error(`relay config agent "${name}" account "${acc.id}" priority must be an integer`);
        if (acc.disabled !== undefined && typeof acc.disabled !== "boolean") throw new Error(`relay config agent "${name}" account "${acc.id}" disabled must be a boolean`);
      }
    }
  }
  for (const a of Object.values(cfg.agents as Record<string, RelayAgent>)) registerEnvSecrets(a.env);
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
