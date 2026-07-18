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
  
  const actor = await createActor({ name: "test", kind: "human", role: "admin" });
  apiKey = actor.apiKey;
});

afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
  delete process.env.VIBEOPS_RELAY_CONFIG;
});

vi.mock("../src/relay/doctor.js", () => ({
  runDoctor: async () => [
    { name: "claude", binary: "claude", probe: { ok: true } },
    { name: "antigravity", binary: "agy", probe: { ok: false, error: "not found" } }
  ]
}));

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

  // 409 if file exists
  res = await app.request("/relay/bootstrap", { method: "POST", headers: h });
  expect(res.status).toBe(409);

  // after relay.json exists, firstRun should be false
  res = await app.request("/system/first-run", { headers: h });
  data = await res.json();
  expect(data.firstRun).toBe(false);
});
