import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActor } from "../src/services/actors.js";
import { app } from "../src/api/app.js";

test("GET /git/identity returns git config user.name for the relay workdir", async () => {
  const workdir = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "relay-"));
  const cfgPath = join(dir, "relay.json");
  writeFileSync(cfgPath, JSON.stringify({ workdir, agents: {} }));
  const prev = process.env.VIBEOPS_RELAY_CONFIG;
  process.env.VIBEOPS_RELAY_CONFIG = cfgPath;

  const expected = execFileSync("git", ["config", "user.name"], { cwd: workdir, encoding: "utf-8" }).trim();

  const { apiKey } = await createActor({ name: "git-id", kind: "human" });
  const res = await app.request("/git/identity", { headers: { Authorization: `Bearer ${apiKey}` } });

  process.env.VIBEOPS_RELAY_CONFIG = prev;
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ name: expected || null });
});

test("GET /git/identity requires auth", async () => {
  const res = await app.request("/git/identity");
  expect(res.status).toBe(401);
});
