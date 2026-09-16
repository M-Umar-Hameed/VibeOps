import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMcpWiring } from "../src/mcp/autowire.js";
import { installClientConfig } from "../src/mcp/clients.js";
import { getSetting, setSetting, deleteSetting } from "../src/services/settings.js";

// The real `claude` CLI is on PATH in dev/CI images that have Claude Code
// installed, so a genuine `claude mcp list` spawn (MCP_CHECKS.claude) would be
// real and non-deterministic here. Route the claude basename's registration
// check to the same file this suite already writes/reads instead of spawning;
// every other basename keeps the real doctor.ts behavior.
vi.mock("../src/relay/doctor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/relay/doctor.js")>();
  const claudeHasVibeops = (homeDir: string): boolean => {
    const p = join(homeDir, ".claude.json");
    if (!existsSync(p)) return false;
    try {
      const j = JSON.parse(readFileSync(p, "utf-8")) as { mcpServers?: unknown };
      return !!j.mcpServers && typeof j.mcpServers === "object" && !Array.isArray(j.mcpServers) && "vibeops" in (j.mcpServers as object);
    } catch { return false; }
  };
  return {
    ...actual,
    mcpRegistration: async (config: any, name: string, opts: { homeDir?: string; fresh?: boolean } = {}) => {
      const cmd0 = config.agents[name]?.cmd?.[0];
      if (cmd0 && actual.binBasename(cmd0) === "claude") {
        return { registered: claudeHasVibeops(opts.homeDir ?? ""), addCommand: "claude mcp add ..." };
      }
      return actual.mcpRegistration(config, name, opts);
    },
  };
});

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
function writeRelay(cfg: unknown): string {
  const dir = mkTmp("autowire-relay-");
  const p = join(dir, "relay.json");
  writeFileSync(p, JSON.stringify(cfg));
  return p;
}

let priorRelayConfig: string | undefined;
beforeEach(() => {
  priorRelayConfig = process.env.VIBEOPS_RELAY_CONFIG;
});
afterEach(() => {
  if (priorRelayConfig === undefined) delete process.env.VIBEOPS_RELAY_CONFIG;
  else process.env.VIBEOPS_RELAY_CONFIG = priorRelayConfig;
});
afterAll(async () => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  // Leave the shared settings table as we found it.
  await deleteSetting("mcp.laneKey");
});

test("installs vibeops into an uninstalled agy lane and flags mcp:true", async () => {
  const home = mkTmp("autowire-home-");
  const name = uniq("agy");
  const relayPath = writeRelay({ workdir: tmpdir(), agents: { [name]: { cmd: ["agy"], roles: ["work"] } } });
  process.env.VIBEOPS_RELAY_CONFIG = relayPath;

  const { wired, failed } = await ensureMcpWiring({ homeDir: home });
  expect(failed).toEqual([]);
  expect(wired).toEqual([name]);

  const settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");
  const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
  expect(written.mcpServers.vibeops.httpUrl).toBe(`http://127.0.0.1:${process.env.PORT ?? 8787}/mcp`);

  const relayAfter = JSON.parse(readFileSync(relayPath, "utf-8"));
  expect(relayAfter.agents[name].mcp).toBe(true);
});

test("a second pass over the same wired state is a no-op", async () => {
  const home = mkTmp("autowire-home-");
  const name = uniq("agy");
  const relayPath = writeRelay({ workdir: tmpdir(), agents: { [name]: { cmd: ["agy"], roles: ["work"] } } });
  process.env.VIBEOPS_RELAY_CONFIG = relayPath;

  const first = await ensureMcpWiring({ homeDir: home });
  expect(first.wired).toEqual([name]);

  const settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");
  const beforeSecond = JSON.parse(readFileSync(settingsPath, "utf-8"));

  const second = await ensureMcpWiring({ homeDir: home });
  expect(second.wired).toEqual([]);
  expect(second.failed).toEqual([]);

  const afterSecond = JSON.parse(readFileSync(settingsPath, "utf-8"));
  expect(afterSecond).toEqual(beforeSecond);
});

test("a lane with an uncheckable CLI basename is left alone", async () => {
  const home = mkTmp("autowire-home-");
  const name = uniq("cursor-lane");
  // "cursor" is installable (src/mcp/clients.ts) but absent from doctor.ts's
  // MCP_CHECKS table, so mcpRegistration reports it as uncheckable.
  const relayPath = writeRelay({ workdir: tmpdir(), agents: { [name]: { cmd: ["cursor"], roles: ["work"] } } });
  process.env.VIBEOPS_RELAY_CONFIG = relayPath;

  const { wired, failed } = await ensureMcpWiring({ homeDir: home });
  expect(wired).toEqual([]);
  expect(failed).toEqual([]);

  const relayAfter = JSON.parse(readFileSync(relayPath, "utf-8"));
  expect(relayAfter.agents[name].mcp).toBeUndefined();
  expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
});

test("an already-registered agy lane without the mcp flag gets flagged, not reinstalled", async () => {
  const home = mkTmp("autowire-home-");
  const name = uniq("agy");
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  const settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");
  // Seeded with the currently-stored lane key, so the new drift check (ceiling 2)
  // reads this entry as current, not stale, and the "registered, don't touch it"
  // path below is what's actually under test here.
  await setSetting("mcp.laneKey", "pre-existing");
  const preSeeded = { mcpServers: { vibeops: { httpUrl: "http://127.0.0.1:8787/mcp", headers: { Authorization: "Bearer pre-existing" } } } };
  writeFileSync(settingsPath, JSON.stringify(preSeeded));
  const relayPath = writeRelay({ workdir: tmpdir(), agents: { [name]: { cmd: ["agy"], roles: ["work"] } } });
  process.env.VIBEOPS_RELAY_CONFIG = relayPath;

  const { wired, failed } = await ensureMcpWiring({ homeDir: home });
  expect(wired).toEqual([]);
  expect(failed).toEqual([]);

  const relayAfter = JSON.parse(readFileSync(relayPath, "utf-8"));
  expect(relayAfter.agents[name].mcp).toBe(true);

  const settingsAfter = JSON.parse(readFileSync(settingsPath, "utf-8"));
  expect(settingsAfter).toEqual(preSeeded);
});

test("wiring two lanes in one pass mints a single shared lane key", async () => {
  const home = mkTmp("autowire-home-");
  const agyName = uniq("agy");
  const geminiName = uniq("gemini");
  const relayPath = writeRelay({
    workdir: tmpdir(),
    agents: {
      [agyName]: { cmd: ["agy"], roles: ["work"] },
      [geminiName]: { cmd: ["gemini"], roles: ["plan"] },
    },
  });
  process.env.VIBEOPS_RELAY_CONFIG = relayPath;

  const { wired, failed } = await ensureMcpWiring({ homeDir: home });
  expect(failed).toEqual([]);
  expect(wired.sort()).toEqual([agyName, geminiName].sort());

  const key = await getSetting("mcp.laneKey");
  expect(typeof key).toBe("string");
  expect(key!.length).toBeGreaterThan(0);

  const agySettings = JSON.parse(readFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), "utf-8"));
  const geminiSettings = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf-8"));
  expect(agySettings.mcpServers.vibeops.headers.Authorization).toBe(`Bearer ${key}`);
  expect(geminiSettings.mcpServers.vibeops.headers.Authorization).toBe(`Bearer ${key}`);
});

test("a failed install never gets flagged mcp:true", async () => {
  const home = mkTmp("autowire-home-");
  const name = uniq("agy");
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  writeFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), "{ not json");
  const relayPath = writeRelay({ workdir: tmpdir(), agents: { [name]: { cmd: ["agy"], roles: ["work"] } } });
  process.env.VIBEOPS_RELAY_CONFIG = relayPath;

  const { wired, failed } = await ensureMcpWiring({ homeDir: home });
  expect(failed.length).toBe(1);
  expect(failed[0].name).toBe(name);
  expect(wired).toEqual([]);

  const relayAfter = JSON.parse(readFileSync(relayPath, "utf-8"));
  expect(relayAfter.agents[name].mcp).toBeUndefined();
});

test("a rotated lane key self-heals a drifted agy entry", async () => {
  const home = mkTmp("autowire-home-");
  const name = uniq("agy");
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  const settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");
  writeFileSync(settingsPath, JSON.stringify({
    mcpServers: { vibeops: { httpUrl: `http://127.0.0.1:${process.env.PORT ?? 8787}/mcp`, headers: { Authorization: "Bearer old-key" } } },
  }));
  const relayPath = writeRelay({ workdir: tmpdir(), agents: { [name]: { cmd: ["agy"], roles: ["work"] } } });
  process.env.VIBEOPS_RELAY_CONFIG = relayPath;
  await setSetting("mcp.laneKey", "current-key");

  const { wired, failed } = await ensureMcpWiring({ homeDir: home });
  expect(failed).toEqual([]);
  expect(wired).toEqual([name]);

  const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
  expect(written.mcpServers.vibeops.headers.Authorization).toBe("Bearer current-key");
});

test("a drifted entry with no stored lane key is left untouched", async () => {
  await deleteSetting("mcp.laneKey");
  const home = mkTmp("autowire-home-");
  const name = uniq("agy");
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  const settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");
  writeFileSync(settingsPath, JSON.stringify({
    mcpServers: { vibeops: { httpUrl: `http://127.0.0.1:${process.env.PORT ?? 8787}/mcp`, headers: { Authorization: "Bearer old-key" } } },
  }));
  const before = readFileSync(settingsPath, "utf-8");
  const relayPath = writeRelay({ workdir: tmpdir(), agents: { [name]: { cmd: ["agy"], roles: ["work"] } } });
  process.env.VIBEOPS_RELAY_CONFIG = relayPath;

  const { wired, failed } = await ensureMcpWiring({ homeDir: home });
  expect(failed).toEqual([]);
  expect(wired).toEqual([]);
  expect(readFileSync(settingsPath, "utf-8")).toBe(before);
});

test("a correct, current entry is left alone and not reinstalled", async () => {
  const home = mkTmp("autowire-home-");
  const name = uniq("agy");
  const url = `http://127.0.0.1:${process.env.PORT ?? 8787}/mcp`;
  installClientConfig("agy", url, "current-key", home);
  const settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");
  const before = readFileSync(settingsPath, "utf-8");
  const relayPath = writeRelay({ workdir: tmpdir(), agents: { [name]: { cmd: ["agy"], roles: ["work"] } } });
  process.env.VIBEOPS_RELAY_CONFIG = relayPath;
  await setSetting("mcp.laneKey", "current-key");

  const { wired, failed } = await ensureMcpWiring({ homeDir: home });
  expect(failed).toEqual([]);
  expect(wired).toEqual([]);
  expect(readFileSync(settingsPath, "utf-8")).toBe(before);

  const relayAfter = JSON.parse(readFileSync(relayPath, "utf-8"));
  expect(relayAfter.agents[name].mcp).toBe(true);
});

test("the claude lane installs into ~/.claude.json without spawning", async () => {
  const home = mkTmp("autowire-home-");
  const name = uniq("claude");
  const relayPath = writeRelay({ workdir: tmpdir(), agents: { [name]: { cmd: ["claude"], roles: ["work"] } } });
  process.env.VIBEOPS_RELAY_CONFIG = relayPath;

  const { wired, failed } = await ensureMcpWiring({ homeDir: home });
  expect(failed).toEqual([]);
  expect(wired).toEqual([name]);

  const written = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
  expect(written.mcpServers.vibeops.type).toBe("http");
  expect(written.mcpServers.vibeops.url).toBe(`http://127.0.0.1:${process.env.PORT ?? 8787}/mcp`);
  expect(written.mcpServers.vibeops.headers.Authorization).toMatch(/^Bearer /);
});
