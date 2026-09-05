import { execFile } from "node:child_process";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { readClaudeAccount, readCodexAccount } from "../system/agents.js";
import type { RelayConfig } from "./config.js";

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 10 * 60_000;
const DEFAULT_PROBE_ARGS = ["--version"];

// Static per-CLI overrides in case a real agent's --version needs different
// flags. All four known basenames currently agree with the default; the map
// exists so a future vendor quirk is a one-line change here, not in invoke.ts.
const PROBE_ARGS: Record<string, string[]> = {
  claude: ["--version"],
  codex: ["--version"],
  agy: ["--version"],
  gemini: ["--version"],
};

// Only binaries with a KNOWN local auth file get a reader; anything else
// reports known:false rather than guessing at a file format we haven't seen.
const AUTH_READERS: Record<string, (homeDir: string) => boolean> = {
  claude: (homeDir) => readClaudeAccount(homeDir).connected,
  codex: (homeDir) => readCodexAccount(homeDir).connected,
};

// claude/kimi: no reliable local file (scope-dependent), so ask the CLI.
async function cliMcpListHasVibeops(cmd0: string): Promise<boolean> {
  const isWindowsScript = process.platform === "win32" && (cmd0.toLowerCase().endsWith(".cmd") || cmd0.toLowerCase().endsWith(".bat"));
  const { stdout } = await execFileAsync(cmd0, ["mcp", "list"], { timeout: PROBE_TIMEOUT_MS, windowsHide: true, shell: isWindowsScript });
  return /vibeops/i.test(stdout);
}

// agy/gemini persist mcpServers to a known settings file -- read it directly
// (same file the one-click install writes; catches hand-registration too).
function settingsHasVibeops(homeDir: string, rel: string[]): boolean {
  const p = join(homeDir, ...rel);
  if (!existsSync(p)) return false;
  try {
    const j = JSON.parse(readFileSync(p, "utf-8")) as { mcpServers?: unknown };
    return !!j.mcpServers && typeof j.mcpServers === "object" && !Array.isArray(j.mcpServers) && "vibeops" in (j.mcpServers as object);
  } catch { return false; }
}

// ponytail: matches "vibeops" in list output / a present mcpServers.vibeops key;
// a differently-named server pointing at the same URL reads as unregistered.
const MCP_CHECKS: Record<string, (homeDir: string, cmd0: string) => Promise<boolean>> = {
  claude: (_h, cmd0) => cliMcpListHasVibeops(cmd0),
  kimi: (_h, cmd0) => cliMcpListHasVibeops(cmd0),
  agy: (h) => Promise.resolve(settingsHasVibeops(h, [".gemini", "antigravity-cli", "settings.json"])),
  gemini: (h) => Promise.resolve(settingsHasVibeops(h, [".gemini", "settings.json"])),
};

// ponytail: <key> placeholder -- doctor has no API key; UI links /mcp/install
// or the user pastes their key. Exact per-CLI syntax from docs/AGENT_CLIS.md.
const MCP_ADD: Record<string, (url: string) => string> = {
  claude: (url) => `claude mcp add --transport http vibeops ${url} --header "Authorization: Bearer <key>"`,
  kimi: (url) => `kimi mcp add --transport http vibeops ${url} --header "Authorization: Bearer <key>"`,
  agy: (url) => `agy mcp add --header "Authorization: Bearer <key>" vibeops ${url}`,
  gemini: () => `add vibeops to ~/.gemini/settings.json mcpServers, or POST /mcp/install {"client":"gemini"}`,
};

const mcpCache = new Map<string, { value: McpRegStatus | undefined; expiresAt: number }>();

async function computeMcp(agent: RelayConfig["agents"][string], cmd0: string, homeDir: string): Promise<McpRegStatus | undefined> {
  if (agent.mcp !== true) return undefined;
  const bin = binBasename(cmd0);
  const check = MCP_CHECKS[bin];
  if (!check) return undefined; // uncheckable CLI -> never flag
  const registered = await check(homeDir, cmd0).catch(() => false);
  const url = `http://127.0.0.1:${process.env.PORT ?? 8787}/mcp`;
  return { registered, addCommand: MCP_ADD[bin](url) };
}

async function mcpRegStatus(
  agent: RelayConfig["agents"][string], name: string, cmd0: string,
  homeDir: string, now: number, fresh?: boolean,
): Promise<McpRegStatus | undefined> {
  const key = cacheKey(name, cmd0);
  const c = mcpCache.get(key);
  if (!fresh && c && c.expiresAt > now) return c.value;
  const value = await computeMcp(agent, cmd0, homeDir);
  mcpCache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

// Registration-only lookup for the chat CLI-lane prompt gate. Shares mcpCache
// with runDoctor; never triggers the --version probe. Undefined = not
// applicable (no cmd, mcp!=true) or uncheckable CLI -> caller trusts the flag.
export async function mcpRegistration(
  config: RelayConfig, agentName: string, opts: { homeDir?: string; fresh?: boolean } = {},
): Promise<McpRegStatus | undefined> {
  const agent = config.agents[agentName];
  const cmd0 = agent?.cmd?.[0];
  if (!agent || !cmd0) return undefined;
  return mcpRegStatus(agent, agentName, cmd0, opts.homeDir ?? homedir(), Date.now(), opts.fresh);
}

export type ProbeStatus = { ok: boolean; error?: string; spawnFailed?: boolean };
export type AuthStatus = { known: boolean; connected: boolean | null };
export type McpRegStatus = { registered: boolean; addCommand: string };
export type AgentDoctorStatus = {
  name: string; binary: string; probe: ProbeStatus; auth: AuthStatus; lastChecked: string;
  // Present only for a lane with mcp:true whose CLI basename is checkable
  // (claude, kimi, agy, gemini). Omitted otherwise -- never flag what we
  // cannot verify.
  mcp?: McpRegStatus;
};

function binBasename(cmd0: string): string {
  const b = basename(cmd0);
  const ext = extname(b);
  return ext ? b.slice(0, -ext.length) : b;
}

import { existsSync, readFileSync } from "node:fs";

// Never touches agent.cmd's real template (which carries {prompt}/{promptFile}/
// {model}) -- only cmd0 plus a static, per-basename --version-style arg vector.
// This is what keeps the probe from ever sending a paid prompt.
async function probeBinary(cmd0: string): Promise<ProbeStatus> {
  const hasSeparator = cmd0.includes("/") || cmd0.includes("\\");
  if (hasSeparator && !existsSync(cmd0)) {
    return { ok: false, error: "spawn ENOENT", spawnFailed: true };
  }
  const bin = binBasename(cmd0);
  const args = PROBE_ARGS[bin] ?? DEFAULT_PROBE_ARGS;
  try {
    const isWindowsScript = process.platform === "win32" && (cmd0.toLowerCase().endsWith(".cmd") || cmd0.toLowerCase().endsWith(".bat"));
    await execFileAsync(cmd0, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true, shell: isWindowsScript });
    return { ok: true };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    const spawnFailed = typeof err.code === "string";
    const detail = (err.stderr ?? "").trim();
    return { ok: false, error: detail || err.message, spawnFailed };
  }
}

function checkAuth(cmd0: string, homeDir: string): AuthStatus {
  const reader = AUTH_READERS[binBasename(cmd0)];
  if (!reader) return { known: false, connected: null };
  try {
    return { known: true, connected: reader(homeDir) };
  } catch {
    return { known: true, connected: false };
  }
}

type CacheEntry = { status: AgentDoctorStatus; expiresAt: number };
// Keyed by name + binary path: a relay.json edit that changes an agent's cmd
// must invalidate its probe, or a stale spawn-failure would block the fixed
// agent (and vice versa).
const cache = new Map<string, CacheEntry>();
const cacheKey = (name: string, cmd0: string) => `${name}\u0000${cmd0}`;

export async function runDoctor(
  config: RelayConfig, opts: { fresh?: boolean; homeDir?: string } = {},
): Promise<AgentDoctorStatus[]> {
  const homeDir = opts.homeDir ?? homedir();
  const now = Date.now();
  const names = Object.keys(config.agents);

  return Promise.all(names.map(async (name) => {
    const cmd0 = config.agents[name].cmd?.[0];
    if (!cmd0) {
      // sdk agents have no CLI binary to probe; auth is the OAuth token / CLI login.
      return { name, binary: name, probe: { ok: true }, auth: { known: false, connected: null }, lastChecked: new Date(now).toISOString() };
    }
    const cached = cache.get(cacheKey(name, cmd0));
    if (!opts.fresh && cached && cached.expiresAt > now) return cached.status;

    const probe = await probeBinary(cmd0);
    const status: AgentDoctorStatus = {
      name, binary: binBasename(cmd0), probe, auth: checkAuth(cmd0, homeDir),
      mcp: await mcpRegStatus(config.agents[name], name, cmd0, homeDir, now, opts.fresh),
      lastChecked: new Date(now).toISOString(),
    };
    cache.set(cacheKey(name, cmd0), { status, expiresAt: now + CACHE_TTL_MS });
    return status;
  }));
}

// Cache-only reads for the pipeline-start path -- deliberately never trigger a
// fresh probe, so starting a pipeline never pays probe latency. Reads go
// through the same name+binary key, so a probe for a different cmd never
// applies to the agent as currently configured.
function cachedStatus(config: RelayConfig, agentName: string): AgentDoctorStatus | undefined {
  const cmd0 = config.agents[agentName]?.cmd?.[0];
  if (!cmd0) return undefined;
  return cache.get(cacheKey(agentName, cmd0))?.status;
}

// Soft failures (binary ran, exited non-zero) become non-blocking warnings.
export function pipelineStartWarnings(config: RelayConfig, agentNames: string[]): string[] {
  const seen = new Set<string>();
  const warnings: string[] = [];
  for (const name of agentNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    const s = cachedStatus(config, name);
    if (s && !s.probe.ok) warnings.push(`agent "${name}" (${s.binary}): ${s.probe.error ?? "probe failed"}`);
  }
  return warnings;
}

// Hard failures (binary couldn't be spawned at all) block pipeline start --
// starting a run against a renamed/missing binary would just stall mid-run.
export function pipelineStartBlockingError(config: RelayConfig, agentNames: string[]): string | null {
  const seen = new Set<string>();
  for (const name of agentNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    const s = cachedStatus(config, name);
    if (s && !s.probe.ok && s.probe.spawnFailed) {
      return `agent "${name}" (${s.binary}) cannot be spawned: ${s.probe.error ?? "spawn failed"}`;
    }
  }
  return null;
}
