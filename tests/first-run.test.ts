import { expect, test, vi, beforeEach, afterEach } from "vitest";
import { app } from "../src/api/app.js";
import { createActor } from "../src/services/actors.js";
import { getKnownModelsForAgent } from "../src/relay/known-models.js";
import fs from "fs";
import path from "path";
import os from "os";

let tempHome = "";
let apiKey = "";

beforeEach(async () => {
  tempHome = path.join(os.tmpdir(), "vibeops-test-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(tempHome, { recursive: true });
  process.env.VIBEOPS_RELAY_CONFIG = path.join(tempHome, "relay.json");
  
  const actor = await createActor({ name: "first-run-" + Math.random().toString(36).slice(2), kind: "human", role: "admin" });
  apiKey = actor.apiKey;
});

afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
  delete process.env.VIBEOPS_RELAY_CONFIG;
  doctorImpl = () => DEFAULT_DOCTOR;
});

// Shared test DB always has projects; first-run truth needs an empty list.
vi.mock("../src/services/projects.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  listProjects: async () => [],
}));

const DEFAULT_DOCTOR = [
  { name: "claude", binary: "claude", probe: { ok: true } },
  { name: "antigravity", binary: "agy", probe: { ok: false, error: "not found" } },
];
let doctorImpl: (cfg: any) => any[] = () => DEFAULT_DOCTOR;
vi.mock("../src/relay/doctor.js", () => ({ runDoctor: async (cfg: any) => doctorImpl(cfg) }));

// The SDK lane is gated on a real Claude Code login, which the CI box may or
// may not have; both states are asserted below by flipping this.
let sdkCredentials = true;
vi.mock("../src/relay/invoke-sdk.js", () => ({ hasCredentials: () => sdkCredentials }));

test("first-run endpoint and relay/bootstrap", async () => {
  const h = { Authorization: `Bearer ${apiKey}` };

  // Fresh home dir = true
  let res = await app.request("/system/first-run", { headers: h });
  let data = await res.json();
  expect(data.firstRun).toBe(true);

  // bootstrap writes relay.json with only probed agents
  res = await app.request("/relay/bootstrap", { method: "POST", headers: h });
  expect(res.status).toBe(200);
  
  const relayPath = path.join(tempHome, "relay.json");
  expect(fs.existsSync(relayPath)).toBe(true);
  
  const cfg = JSON.parse(fs.readFileSync(relayPath, "utf-8"));
  expect(cfg.agents).toBeDefined();
  expect(cfg.agents.claude).toBeDefined();
  expect(cfg.agents.antigravity).toBeUndefined();

  // Re-running merges rather than failing: it is the only path a user has to
  // pick up a CLI installed after setup.
  res = await app.request("/relay/bootstrap", { method: "POST", headers: h });
  expect(res.status).toBe(200);

  // after relay.json exists, firstRun should be false
  res = await app.request("/system/first-run", { headers: h });
  data = await res.json();
  expect(data.firstRun).toBe(false);
});

test("relay/bootstrap adds the sdk work lane when Claude credentials exist", async () => {
  const h = { Authorization: `Bearer ${apiKey}` };
  sdkCredentials = true;
  expect((await app.request("/relay/bootstrap", { method: "POST", headers: h })).status).toBe(200);
  const cfg = JSON.parse(fs.readFileSync(path.join(tempHome, "relay.json"), "utf-8"));
  expect(cfg.agents["claude-sdk"]).toEqual({
    type: "sdk", roles: ["work"],
    models: getKnownModelsForAgent("claude-sdk").map((k) => ({ name: k.name || k.id, tier: k.tier, quality: k.quality })),
  });
});

test("relay/bootstrap omits the sdk lane when there are no Claude credentials", async () => {
  const h = { Authorization: `Bearer ${apiKey}` };
  sdkCredentials = false;
  expect((await app.request("/relay/bootstrap", { method: "POST", headers: h })).status).toBe(200);
  const cfg = JSON.parse(fs.readFileSync(path.join(tempHome, "relay.json"), "utf-8"));
  expect(cfg.agents["claude-sdk"]).toBeUndefined();
});

test("relay/bootstrap leaves a hand-configured agent exactly as written", async () => {
  const h = { Authorization: `Bearer ${apiKey}` };
  const relayPath = path.join(tempHome, "relay.json");
  const mine = { cmd: ["my-own-claude"], roles: ["work"] };
  fs.writeFileSync(relayPath, JSON.stringify({ workdir: tempHome, agents: { claude: mine } }));

  expect((await app.request("/relay/bootstrap", { method: "POST", headers: h })).status).toBe(200);

  const cfg = JSON.parse(fs.readFileSync(relayPath, "utf-8"));
  expect(cfg.agents.claude).toEqual(mine);
  expect(cfg.workdir).toBe(tempHome);
});

test("relay/bootstrap fills models only for an agent whose cmd takes {model}, and never rewrites its cmd", async () => {
  const h = { Authorization: `Bearer ${apiKey}` };
  const relayPath = path.join(tempHome, "relay.json");
  const cmd = ["claude", "--model", "{model}", "-p", "{promptFile}"];
  fs.writeFileSync(relayPath, JSON.stringify({ workdir: tempHome, agents: { claude: { cmd, roles: ["work"] } } }));

  expect((await app.request("/relay/bootstrap", { method: "POST", headers: h })).status).toBe(200);

  const cfg = JSON.parse(fs.readFileSync(relayPath, "utf-8"));
  expect(cfg.agents.claude.cmd).toEqual(cmd);
  expect(cfg.agents.claude.models.length).toBeGreaterThan(0);
});

test("relay/bootstrap removes an agent whose program is missing and keeps the rest", async () => {
  const h = { Authorization: `Bearer ${apiKey}` };
  const relayPath = path.join(tempHome, "relay.json");
  const claude = { cmd: ["claude", "--model", "{model}", "-p", "{promptFile}"], roles: ["work"], models: [{ name: "Opus 5", tier: "expensive", quality: 5 }] };
  const sdk = { type: "sdk", roles: ["work"], models: [{ name: "Opus 5", tier: "expensive", quality: 5 }] };
  fs.writeFileSync(relayPath, JSON.stringify({ workdir: tempHome, agents: {
    claude, "claude-sdk": sdk,
    codex: { cmd: ["codex", "exec", "{prompt}"], roles: ["work"] },
    kimi: { cmd: ["kimi", "-p", "{promptFile}"], roles: ["work"] },
  } }));
  doctorImpl = (cfg) => Object.keys(cfg.agents).map((name) =>
    name === "codex" ? { name, binary: "codex", probe: { ok: false, error: "spawn codex ENOENT", spawnFailed: true } }
    : name === "kimi" ? { name, binary: "kimi", probe: { ok: false, error: "not logged in", spawnFailed: false } }
    : { name, binary: name, probe: { ok: true } });

  const res = await app.request("/relay/bootstrap", { method: "POST", headers: h });
  expect(res.status).toBe(200);
  expect((await res.json()).removed).toEqual(["codex"]);

  const cfg = JSON.parse(fs.readFileSync(relayPath, "utf-8"));
  expect(cfg.agents.codex).toBeUndefined();
  expect(cfg.agents.kimi).toBeDefined();
  expect(cfg.agents.claude).toEqual(claude);
  expect(cfg.agents["claude-sdk"]).toEqual(sdk);
  expect(fs.existsSync(`${relayPath}.bak`)).toBe(true);
});

test("relay/bootstrap does not re-add a stock template under the name it just removed", async () => {
  const h = { Authorization: `Bearer ${apiKey}` };
  const relayPath = path.join(tempHome, "relay.json");
  fs.writeFileSync(relayPath, JSON.stringify({ workdir: tempHome, agents: {
    codex: { cmd: ["C:/gone/codex.exe", "exec", "{prompt}"], roles: ["work"] },
  } }));
  doctorImpl = (cfg) => Object.keys(cfg.agents).map((name) =>
    cfg.agents[name].cmd?.[0] === "C:/gone/codex.exe"
      ? { name, binary: "codex", probe: { ok: false, error: "spawn ENOENT", spawnFailed: true } }
      : { name, binary: name, probe: { ok: true } });

  const res = await app.request("/relay/bootstrap", { method: "POST", headers: h });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.removed).toEqual(["codex"]);
  expect(body.added).not.toContain("codex");
  const cfg = JSON.parse(fs.readFileSync(relayPath, "utf-8"));
  expect(cfg.agents.codex).toBeUndefined();
});

test("forge/doctor is empty without a relay.json and names the problem when one is broken", async () => {
  const h = { Authorization: `Bearer ${apiKey}` };
  const relayPath = path.join(tempHome, "relay.json");

  let res = await app.request("/forge/doctor", { headers: h });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([]);

  fs.writeFileSync(relayPath, "{ not json");
  res = await app.request("/forge/doctor", { headers: h });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("not valid JSON");
});
