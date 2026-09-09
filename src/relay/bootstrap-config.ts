import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateRelayConfig } from "./config.js";
import type { RelayAgent, RelayConfig } from "./config.js";

// cmd is absent on sdk/http lanes; config.ts validates that per type.
type AgentEntry = Omit<RelayAgent, "cmd"> & { cmd?: string[] };

export function relayConfigPath(): string {
  return process.env.VIBEOPS_RELAY_CONFIG ?? join(homedir(), ".vibeops", "relay.json");
}

// The only sanctioned way to write relay.json. Checks the result against the
// same rules loadRelayConfig applies on read, so a writer can never leave a
// file that no route can load: the caller gets the error instead of the user
// getting a bricked install.
export function writeRelayConfig(cfg: unknown): RelayConfig {
  const path = relayConfigPath();
  const valid = validateRelayConfig(cfg, path);
  try {
    if (existsSync(path)) {
      copyFileSync(path, `${path}.bak`);
    }
  } catch {}
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf-8");
    renameSync(tmp, path);
  } catch {
    writeFileSync(path, JSON.stringify(cfg, null, 2), "utf-8");
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
  }
  return valid;
}

function sandboxDir(): string {
  return join(homedir(), ".vibeops", "sandbox");
}

function templates(): Record<string, AgentEntry> {
  return {
    claude: { cmd: ["claude", "-p", "{promptFile}"], roles: ["plan", "review"] },
    agy: { cmd: ["agy", "exec", "-C", "{workdir}", "{prompt}"], roles: ["work", "plan"] },
    agy_local: { cmd: [join(homedir(), "AppData", "Local", "agy", "bin", "agy.exe"), "exec", "-C", "{workdir}", "{prompt}"], roles: ["work", "plan"] },
    codex: { cmd: ["codex", "exec", "-C", "{workdir}", "{prompt}"], roles: ["work"] },
    kimi: { cmd: ["kimi", "-p", "{promptFile}"], roles: ["work"] },
    gemini: { cmd: ["gemini", "prompt", "--", "{prompt}"], roles: ["plan", "review"] },
  };
}

// Probes every known CLI and keeps the ones that answered, plus the SDK lane
// when a Claude Code login is on the machine. Agents already in the file are
// left exactly as the user has them and only new names are added, so this is
// safe to re-run after installing a CLI. ponytail: re-running also re-adds an
// agent the user deliberately deleted; a "dismissed" list in the config is the
// upgrade path if that ever annoys anyone.
export async function bootstrapRelayConfig(): Promise<{ config: RelayConfig; added: string[] }> {
  const path = relayConfigPath();
  const existed = existsSync(path);
  let current: { workdir?: string; agents?: Record<string, AgentEntry> } = {};
  if (existed) {
    try {
      current = JSON.parse(readFileSync(path, "utf-8"));
    } catch (e) {
      // Never overwrite a file we could not read: the user's hand-edited
      // config is worth more than a clean bootstrap.
      throw new Error(`relay config at ${path} is not valid JSON: ${(e as Error).message}`);
    }
  }

  const known = templates();
  const { runDoctor } = await import("./doctor.js");
  const statuses = await runDoctor(
    { workdir: sandboxDir(), agents: known } as unknown as RelayConfig, { fresh: true },
  );

  const detected: Record<string, AgentEntry> = {};
  for (const s of statuses) {
    if (!s.probe.ok) continue;
    // Both antigravity templates land on one "agy" agent; first one to answer wins.
    const name = s.name === "agy_local" ? "agy" : s.name;
    if (!detected[name]) detected[name] = known[s.name];
  }

  // The SDK lane spawns no binary, so a machine where every CLI probe failed
  // still gets a work lane from the Claude Code login already on it.
  const { hasCredentials } = await import("./invoke-sdk.js");
  if (hasCredentials()) detected["claude-sdk"] = { type: "sdk", roles: ["work"] };

  const agents = { ...(current.agents ?? {}) };
  for (const [, a] of Object.entries(agents)) {
    if (a.type === "sdk" && Array.isArray(a.roles) && a.roles.some((r: string) => r !== "work")) {
      a.roles = ["work"];
    }
    if (Array.isArray(a.models) && a.models.length === 0) {
      delete a.models;
    }
  }
  const added: string[] = [];
  for (const [name, agent] of Object.entries(detected)) {
    if (agents[name]) continue;
    agents[name] = agent;
    added.push(name);
  }

  const config = { ...current, workdir: current.workdir ?? sandboxDir(), agents } as unknown as RelayConfig;
  // Nothing new and the file is already there: leave the user's formatting alone.
  if (added.length || !existed) writeRelayConfig(config);
  return { config, added };
}
