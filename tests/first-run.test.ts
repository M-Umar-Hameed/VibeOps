import { expect, test, vi, beforeEach, afterEach } from "vitest";
import { app } from "../src/api/app.js";
import { createActor } from "../src/services/actors.js";
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
});

// Shared test DB always has projects; first-run truth needs an empty list.
vi.mock("../src/services/projects.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  listProjects: async () => [],
}));

vi.mock("../src/relay/doctor.js", () => ({
  runDoctor: async () => [
    { name: "claude", binary: "claude", probe: { ok: true } },
    { name: "antigravity", binary: "agy", probe: { ok: false, error: "not found" } }
  ]
}));

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
  expect(cfg.agents["claude-sdk"]).toEqual({ type: "sdk", roles: ["work"] });
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
