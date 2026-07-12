import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
} as const;
export type InstallableClient = keyof typeof CLIENTS;

export function buildMcpConfig(url: string, apiKey: string) {
  const path = (c: InstallableClient) => join(homedir(), ...CLIENTS[c].rel);
  return {
    url,
    claudeCode: {
      command: `claude mcp add --transport http vibeops ${url} --header "Authorization: Bearer ${apiKey}"`,
    },
    cursor: { path: path("cursor"), snippet: { mcpServers: { vibeops: CLIENTS.cursor.entry(url, apiKey) } } },
    gemini: { path: path("gemini"), snippet: { mcpServers: { vibeops: CLIENTS.gemini.entry(url, apiKey) } } },
  };
}

export function installClientConfig(
  client: InstallableClient, url: string, apiKey: string, homeDir: string = homedir(),
): { path: string; backedUp: boolean } {
  const spec = CLIENTS[client];
  if (!spec) throw new Error(`unknown client: ${client}`);
  const path = join(homeDir, ...spec.rel);
  let existing: Record<string, unknown> = {};
  let backedUp = false;
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf-8");
    try {
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(`unparseable JSON at ${path}; not touching it`);
    }
    copyFileSync(path, path + ".vibeops-backup");
    backedUp = true;
  }
  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
  servers.vibeops = spec.entry(url, apiKey);
  existing.mcpServers = servers;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(existing, null, 2) + "\n");
  return { path, backedUp };
}
