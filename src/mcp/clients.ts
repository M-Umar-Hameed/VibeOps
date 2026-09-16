import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CLIENTS = {
  cursor: {
    rel: [".cursor", "mcp.json"],
    entry: (url: string, key: string) => ({ url, headers: { Authorization: `Bearer ${key}` } }),
  },
  gemini: {
    rel: [".gemini", "settings.json"],
    entry: (url: string, key: string) => ({ httpUrl: url, headers: { Authorization: `Bearer ${key}` } }),
  },
  // ponytail: Antigravity is Gemini-family; assume the same httpUrl entry shape.
  // `agy mcp add` persists mcpServers here (docs/AGENT_CLIS.md, ticket 2026-08-26).
  agy: {
    rel: [".gemini", "antigravity-cli", "settings.json"],
    entry: (url: string, key: string) => ({ httpUrl: url, headers: { Authorization: `Bearer ${key}` } }),
  },
  claude: {
    rel: [".claude.json"],
    entry: (url: string, key: string) => ({ type: "http", url, headers: { Authorization: `Bearer ${key}` } }),
  },
} as const;
export type InstallableClient = keyof typeof CLIENTS;
export const INSTALLABLE_CLIENTS = Object.keys(CLIENTS) as InstallableClient[];

export function buildMcpConfig(url: string, apiKey: string) {
  const path = (c: InstallableClient) => join(homedir(), ...CLIENTS[c].rel);
  return {
    url,
    claudeCode: {
      command: `claude mcp add --transport http vibeops ${url} --header "Authorization: Bearer ${apiKey}"`,
    },
    cursor: { path: path("cursor"), snippet: { mcpServers: { vibeops: CLIENTS.cursor.entry(url, apiKey) } } },
    gemini: { path: path("gemini"), snippet: { mcpServers: { vibeops: CLIENTS.gemini.entry(url, apiKey) } } },
    agy: { path: path("agy"), snippet: { mcpServers: { vibeops: CLIENTS.agy.entry(url, apiKey) } } },
    claude: { path: path("claude"), snippet: { mcpServers: { vibeops: CLIENTS.claude.entry(url, apiKey) } } },
  };
}

export function installClientConfig(
  client: InstallableClient, url: string, apiKey: string, homeDir: string = homedir(),
): { path: string; backedUp: boolean } {
  const spec = CLIENTS[client];
  if (!spec) throw new Error(`unknown client: ${client}`);
  const path = join(homeDir, ...spec.rel);
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf-8");
    try {
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(`unparseable JSON at ${path}; not touching it`);
    }
    // Validate mcpServers shape before proceeding
    if ("mcpServers" in existing && existing.mcpServers !== null && typeof existing.mcpServers !== "object") {
      throw new Error(`unexpected mcpServers shape at ${path}; not touching it`);
    }
    if ("mcpServers" in existing && Array.isArray(existing.mcpServers)) {
      throw new Error(`unexpected mcpServers shape at ${path}; not touching it`);
    }
  }
  // Only create backup if one doesn't already exist
  const backupPath = path + ".vibeops-backup";
  if (existsSync(path) && !existsSync(backupPath)) {
    copyFileSync(path, backupPath);
    try { chmodSync(backupPath, 0o600); } catch { /* fs without POSIX modes */ }
  }
  const backedUp = existsSync(backupPath);
  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
  servers.vibeops = spec.entry(url, apiKey);
  existing.mcpServers = servers;
  // These files carry the API key — same trust level as ~/.vibeops/credentials.json.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(existing, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* fs without POSIX modes */ }
  return { path, backedUp };
}

// True when the client's config already holds exactly the entry we would write.
// A drifted url or key (rotated, revoked, port moved) reads as false so the
// caller can re-install, which a name-only check cannot detect.
export function clientEntryCurrent(
  client: InstallableClient, url: string, apiKey: string, homeDir: string = homedir(),
): boolean {
  const spec = CLIENTS[client];
  const path = join(homeDir, ...spec.rel);
  if (!existsSync(path)) return false;
  try {
    const existing = JSON.parse(readFileSync(path, "utf-8")) as { mcpServers?: Record<string, unknown> };
    // Both sides are plain objects built the same way, so JSON.stringify
    // equality is a sufficient value-compare here.
    return JSON.stringify(existing.mcpServers?.vibeops) === JSON.stringify(spec.entry(url, apiKey));
  } catch {
    return false;
  }
}
