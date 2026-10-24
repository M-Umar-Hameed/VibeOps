import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const active = vi.hoisted(() => ({ value: false }));
vi.mock("../src/forge/runs.js", () => ({
  hasAnyActiveRun: () => active.value,
  activeStageForTicket: () => undefined,
  listRuns: () => [],
  hasActiveRun: async () => false,
}));

import { app } from "../src/api/app.js";
import { createActor } from "../src/services/actors.js";
import { readAccountState } from "../src/relay/account-state.js";
import { vibeopsHome } from "../src/runtime/home.js";

const LOGIN_OK = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "login-ok.cjs");
const prevClaudeDir = process.env.CLAUDE_CONFIG_DIR;
function uniq(p: string) { return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
async function headers(role?: "admin"): Promise<Record<string, string>> {
  const { apiKey } = await createActor({ name: uniq("acct-api"), kind: "human", ...(role ? { role } : {}) });
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

let root: string, cfgPath: string, dirA: string, bin: string;
const readCfg = () => JSON.parse(readFileSync(cfgPath, "utf-8"));
const writeCfg = (agents: Record<string, unknown>) => writeFileSync(cfgPath, JSON.stringify({ workdir: join(root, "work"), agents }));
const codexLane = (extra: Record<string, unknown> = {}) => ({
  cmd: [bin, "exec", "{prompt}"], roles: ["work"],
  accounts: [{ id: "main", label: "Main", configDir: dirA, priority: 1 }], ...extra,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "acct-api-"));
  mkdirSync(join(root, "work"));
  cfgPath = join(root, "relay.json");
  dirA = join(root, "login-a");
  mkdirSync(dirA);
  bin = join(root, process.platform === "win32" ? "codex.exe" : "codex");
  copyFileSync(process.execPath, bin);
  chmodSync(bin, 0o755);
  process.env.VIBEOPS_RELAY_CONFIG = cfgPath;
  active.value = false;
  writeCfg({ codex: codexLane(), gemini: { cmd: ["gemini", "prompt", "--", "{prompt}"], roles: ["plan"] } });
});
afterEach(() => {
  delete process.env.VIBEOPS_RELAY_CONFIG;
  if (prevClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevClaudeDir;
  rmSync(root, { recursive: true, force: true });
});

describe("relay accounts API", () => {
  it("member is refused", async () => {
    const res = await app.request("/relay/accounts", { headers: await headers() });
    expect(res.status).toBe(403);
  });

  it("lists subscription lanes only, with login step and stats", async () => {
    const res = await app.request("/relay/accounts", { headers: await headers("admin") });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runsActive).toBe(false);
    expect(body.lanes.map((l: any) => l.agent)).toEqual(["codex"]);
    const a = body.lanes[0].accounts[0];
    expect(a).toMatchObject({ id: "main", label: "Main", runs: 0, lastRunAt: null });
    expect(a.login.command).toContain("CODEX_HOME");
    expect(a.login.command).toContain("codex login");
    expect(body.lanes[0].canCheckLogin).toBe(true);
  });

  it("add creates the folder under ~/.vibeops/accounts and appends with the next priority", async () => {
    const h = await headers("admin");
    const res = await app.request("/relay/agents/codex/accounts", { method: "POST", headers: h, body: JSON.stringify({ label: "Backup" }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.account.configDir.startsWith(join(vibeopsHome(), ".vibeops", "accounts", "codex"))).toBe(true);
    expect(existsSync(body.account.configDir)).toBe(true);
    expect(body.login.command).toContain(body.account.configDir);
    const accounts = readCfg().agents.codex.accounts;
    expect(accounts).toHaveLength(2);
    expect(accounts[1]).toMatchObject({ label: "Backup", priority: 2 });
  });

  it("add rejects a relative folder and an unsupported lane", async () => {
    const h = await headers("admin");
    const rel = await app.request("/relay/agents/codex/accounts", { method: "POST", headers: h, body: JSON.stringify({ label: "X", configDir: "rel/dir" }) });
    expect(rel.status).toBe(400);
    const gem = await app.request("/relay/agents/gemini/accounts", { method: "POST", headers: h, body: JSON.stringify({ label: "X" }) });
    expect(gem.status).toBe(400);
  });

  it("every relay.json write is blocked while runs are active", async () => {
    active.value = true;
    const h = await headers("admin");
    const before = readFileSync(cfgPath, "utf-8");
    const calls: [string, RequestInit][] = [
      ["/relay/agents/codex/accounts", { method: "POST", headers: h, body: JSON.stringify({ label: "B" }) }],
      ["/relay/agents/codex/accounts/order", { method: "PUT", headers: h, body: JSON.stringify({ ids: ["main"] }) }],
      ["/relay/agents/codex/accounts/main", { method: "PATCH", headers: h, body: JSON.stringify({ disabled: true }) }],
      ["/relay/agents/codex/accounts/main", { method: "DELETE", headers: h, body: JSON.stringify({}) }],
    ];
    for (const [path, init] of calls) {
      const res = await app.request(path, init);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "wait until runs finish" });
    }
    expect(readFileSync(cfgPath, "utf-8")).toBe(before);
    const list = await (await app.request("/relay/accounts", { headers: h })).json();
    expect(list.runsActive).toBe(true);
  });

  it("add on a claude lane copies CLAUDE.md and settings.json", async () => {
    const main = join(root, "main-claude");
    mkdirSync(main);
    writeFileSync(join(main, "CLAUDE.md"), "rules");
    writeFileSync(join(main, "settings.json"), "{}");
    process.env.CLAUDE_CONFIG_DIR = main;
    writeCfg({ claude: { cmd: ["claude", "-p", "{promptFile}"], roles: ["plan"] } });
    const res = await app.request("/relay/agents/claude/accounts", { method: "POST", headers: await headers("admin"), body: JSON.stringify({ label: "Second", copySettings: true }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.copied).toEqual(["CLAUDE.md", "settings.json"]);
    expect(readFileSync(join(body.account.configDir, "CLAUDE.md"), "utf-8")).toBe("rules");
    expect(body.login.command).toContain("CLAUDE_CONFIG_DIR");
    expect(body.login.then).toBe("type /login");
  });

  it("order sets priorities; a partial list is refused", async () => {
    const dirB = join(root, "login-b");
    writeCfg({ codex: codexLane({ accounts: [
      { id: "main", label: "Main", configDir: dirA, priority: 1 },
      { id: "backup", label: "B", configDir: dirB, priority: 2 },
    ] }) });
    const h = await headers("admin");
    const bad = await app.request("/relay/agents/codex/accounts/order", { method: "PUT", headers: h, body: JSON.stringify({ ids: ["main"] }) });
    expect(bad.status).toBe(400);
    const ok = await app.request("/relay/agents/codex/accounts/order", { method: "PUT", headers: h, body: JSON.stringify({ ids: ["backup", "main"] }) });
    expect(ok.status).toBe(200);
    const accounts = readCfg().agents.codex.accounts;
    expect(accounts.find((a: any) => a.id === "backup").priority).toBe(1);
    expect(accounts.find((a: any) => a.id === "main").priority).toBe(2);
  });

  it("patch disables an account", async () => {
    const res = await app.request("/relay/agents/codex/accounts/main", { method: "PATCH", headers: await headers("admin"), body: JSON.stringify({ disabled: true }) });
    expect(res.status).toBe(200);
    expect(readCfg().agents.codex.accounts[0].disabled).toBe(true);
  });

  it("remove keeps the folder; deleting a folder outside ~/.vibeops/accounts is refused", async () => {
    const h = await headers("admin");
    const refused = await app.request("/relay/agents/codex/accounts/main", { method: "DELETE", headers: h, body: JSON.stringify({ deleteFolder: true }) });
    expect(refused.status).toBe(400);
    const res = await app.request("/relay/agents/codex/accounts/main", { method: "DELETE", headers: h, body: JSON.stringify({}) });
    expect(res.status).toBe(200);
    expect(readCfg().agents.codex.accounts).toBeUndefined();
    expect(existsSync(dirA)).toBe(true);
  });

  it("remove with deleteFolder deletes a folder under ~/.vibeops/accounts", async () => {
    const h = await headers("admin");
    const add = await (await app.request("/relay/agents/codex/accounts", { method: "POST", headers: h, body: JSON.stringify({ label: "Tmp" }) })).json();
    const res = await app.request(`/relay/agents/codex/accounts/${add.account.id}`, { method: "DELETE", headers: h, body: JSON.stringify({ deleteFolder: true }) });
    expect(res.status).toBe(200);
    expect(existsSync(add.account.configDir)).toBe(false);
  });

  it("check login runs the probe with the account env and records the result", async () => {
    const h = await headers("admin");
    writeCfg({ codex: codexLane({ env: { NODE_OPTIONS: `--require "${LOGIN_OK.replace(/\\/g, "/")}"` } }) });
    const ok = await app.request("/relay/agents/codex/accounts/main/check", { method: "POST", headers: h });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect((await readAccountState(dirA)).loginOk).toBe(true);
    writeCfg({ codex: codexLane() });
    const bad = await app.request("/relay/agents/codex/accounts/main/check", { method: "POST", headers: h });
    expect((await bad.json()).ok).toBe(false);
    expect((await readAccountState(dirA)).loginOk).toBe(false);
  }, 60_000);
});
