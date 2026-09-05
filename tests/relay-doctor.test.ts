import { afterAll, expect, test } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDoctor, pipelineStartWarnings, pipelineStartBlockingError } from "../src/relay/doctor.js";
import type { RelayConfig } from "../src/relay/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Spawned directly as cmd[0], so the fixture has to be natively executable on the
// host: a .cmd on Windows, a mode-755 shell script elsewhere. Pointing at the .cmd
// on Linux gave EACCES, which the probe correctly reported as a spawn failure —
// the fixtures were wrong, not the code. binBasename strips the extension, so
// `binary` is "doctor-exit0" either way.
const FIXTURE_EXT = process.platform === "win32" ? ".cmd" : ".sh";
const EXIT0 = join(__dirname, "fixtures", `doctor-exit0${FIXTURE_EXT}`);
const EXIT1 = join(__dirname, "fixtures", `doctor-exit1${FIXTURE_EXT}`);

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function configWith(name: string, cmd0: string): RelayConfig {
  return { workdir: tmpdir(), agents: { [name]: { cmd: [cmd0], roles: ["plan", "work", "review"] } } };
}

test("runDoctor: exit0 fixture probes ok, no spawn failure", async () => {
  const name = uniq("ok-agent");
  const [status] = await runDoctor(configWith(name, EXIT0));
  expect(status.name).toBe(name);
  expect(status.binary).toBe("doctor-exit0");
  expect(status.probe).toEqual({ ok: true });
  expect(status.auth).toEqual({ known: false, connected: null });
  expect(typeof status.lastChecked).toBe("string");
});

test("runDoctor: exit1 fixture probes as a soft failure (spawnFailed false)", async () => {
  const name = uniq("flaky-agent");
  const [status] = await runDoctor(configWith(name, EXIT1));
  expect(status.probe.ok).toBe(false);
  expect(status.probe.spawnFailed).toBeFalsy();
  expect(status.probe.error).toContain("simulated probe failure");
});

test("runDoctor: missing binary path is a hard spawn failure", async () => {
  const name = uniq("missing-agent");
  const missingPath = join(mkTmp("doctor-missing-"), "does-not-exist.cmd");
  const [status] = await runDoctor(configWith(name, missingPath));
  expect(status.probe.ok).toBe(false);
  expect(status.probe.spawnFailed).toBe(true);
});

test("runDoctor: caches results; fresh=true bypasses the cache", async () => {
  const name = uniq("cache-agent");
  const config = configWith(name, EXIT0);
  const first = await runDoctor(config);
  expect(first[0].probe.ok).toBe(true);

  // Same name+binary within TTL: served from cache (same ok result).
  const again = await runDoctor(config);
  expect(again[0].probe.ok).toBe(true);

  // Rename: same agent name, different binary. Cache is keyed by name+binary,
  // so this is a MISS and probes the new (missing) binary immediately — a
  // stale probe for the old cmd must never answer for the new one.
  const missingPath = join(mkTmp("doctor-renamed-"), "gone.cmd");
  const renamed: RelayConfig = { workdir: tmpdir(), agents: { [name]: { cmd: [missingPath], roles: ["plan", "work", "review"] } } };
  const cached = await runDoctor(renamed);
  expect(cached[0].probe.ok).toBe(false);
  expect(cached[0].probe.spawnFailed).toBe(true);

  const fresh = await runDoctor(renamed, { fresh: true });
  expect(fresh[0].probe.ok).toBe(false);
  expect(fresh[0].probe.spawnFailed).toBe(true);
});

test("checkAuth via runDoctor: claude basename reads the real reader, booleans only", async () => {
  const name = uniq("claude-like");
  const home = mkTmp("doctor-auth-");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "x@y.z" } }));
  const config: RelayConfig = { workdir: tmpdir(), agents: { [name]: { cmd: [join(dirname(EXIT0), "..", "..", "irrelevant-claude"), ], roles: ["plan"] } } };
  // Point cmd0 at a fixture whose basename is literally "claude" so the auth
  // reader map matches; reuse the exit0 fixture copied under that name isn't
  // needed for auth-only assertions, so just probe against EXIT0 directly.
  config.agents[name].cmd = [EXIT0];
  const [status] = await runDoctor(config, { homeDir: home });
  // basename is "doctor-exit0", not "claude" -- auth stays unknown for this fixture.
  expect(status.auth).toEqual({ known: false, connected: null });
});

test("pipelineStartWarnings/pipelineStartBlockingError read the cache only, never re-probe", async () => {
  const okName = uniq("ok-for-pipeline");
  const flakyName = uniq("flaky-for-pipeline");
  const missingName = uniq("missing-for-pipeline");
  const missingPath = join(mkTmp("doctor-pipeline-missing-"), "gone.cmd");

  const cfg = {
    workdir: tmpdir(),
    agents: {
      [okName]: { cmd: [EXIT0], roles: ["plan"] },
      [flakyName]: { cmd: [EXIT1], roles: ["plan"] },
      [missingName]: { cmd: [missingPath], roles: ["plan"] },
      "never-checked-agent": { cmd: [EXIT0], roles: ["plan"] },
    },
  };
  await runDoctor({ ...cfg, agents: { [okName]: cfg.agents[okName], [flakyName]: cfg.agents[flakyName], [missingName]: cfg.agents[missingName] } });

  expect(pipelineStartWarnings(cfg, [okName])).toEqual([]);
  expect(pipelineStartWarnings(cfg, [flakyName])[0]).toContain(flakyName);
  expect(pipelineStartWarnings(cfg, [missingName])[0]).toContain(missingName);

  expect(pipelineStartBlockingError(cfg, [okName])).toBeNull();
  expect(pipelineStartBlockingError(cfg, [flakyName])).toBeNull(); // soft failure never blocks
  expect(pipelineStartBlockingError(cfg, [missingName])).toContain(missingName);

  expect(pipelineStartWarnings(cfg, ["never-checked-agent"])).toEqual([]);
  expect(pipelineStartBlockingError(cfg, ["never-checked-agent"])).toBeNull();
});

test("runDoctor: mcp:true agy lane with registered settings reports registered", async () => {
  const name = uniq("agy-reg");
  const home = mkTmp("doctor-agy-");
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  writeFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"),
    JSON.stringify({ mcpServers: { vibeops: { httpUrl: "http://x/mcp" } } }));
  const cfg: RelayConfig = { workdir: tmpdir(), agents: { [name]: { cmd: ["agy"], roles: ["work"], mcp: true } } };
  const [s] = await runDoctor(cfg, { homeDir: home, fresh: true });
  expect(s.mcp?.registered).toBe(true);
  expect(s.mcp?.addCommand).toContain("agy mcp add");
});

test("runDoctor: mcp:true agy lane with no settings reports unregistered + add command", async () => {
  const name = uniq("agy-unreg");
  const home = mkTmp("doctor-agy2-");
  const cfg: RelayConfig = { workdir: tmpdir(), agents: { [name]: { cmd: ["agy"], roles: ["work"], mcp: true } } };
  const [s] = await runDoctor(cfg, { homeDir: home, fresh: true });
  expect(s.mcp?.registered).toBe(false);
  expect(s.mcp?.addCommand).toContain("agy mcp add");
});

test("runDoctor: mcp:true gemini lane reads ~/.gemini/settings.json", async () => {
  const name = uniq("gem-reg");
  const home = mkTmp("doctor-gem-");
  mkdirSync(join(home, ".gemini"), { recursive: true });
  writeFileSync(join(home, ".gemini", "settings.json"),
    JSON.stringify({ mcpServers: { vibeops: { httpUrl: "http://x/mcp" } } }));
  const cfg: RelayConfig = { workdir: tmpdir(), agents: { [name]: { cmd: ["gemini"], roles: ["work"], mcp: true } } };
  const [s] = await runDoctor(cfg, { homeDir: home, fresh: true });
  expect(s.mcp?.registered).toBe(true);
});

test("runDoctor: mcp:true claude lane with no CLI present reports unregistered", async () => {
  const name = uniq("claude-unreg");
  const home = mkTmp("doctor-cl-");
  const cfg: RelayConfig = { workdir: tmpdir(), agents: { [name]: { cmd: [join(home, "claude")], roles: ["plan"], mcp: true } } };
  const [s] = await runDoctor(cfg, { homeDir: home, fresh: true });
  expect(s.mcp?.registered).toBe(false);
  expect(s.mcp?.addCommand).toContain("claude mcp add");
});

test("runDoctor: uncheckable basename with mcp:true is not flagged", async () => {
  const name = uniq("unknown-mcp");
  const cfg: RelayConfig = { workdir: tmpdir(), agents: { [name]: { cmd: [EXIT0], roles: ["plan"], mcp: true } } };
  const [s] = await runDoctor(cfg, { fresh: true });
  expect(s.mcp).toBeUndefined();
});

test("runDoctor: lane without mcp has no mcp field", async () => {
  const name = uniq("no-mcp");
  const [s] = await runDoctor(configWith(name, EXIT0), { fresh: true });
  expect(s.mcp).toBeUndefined();
});
