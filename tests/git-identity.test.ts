import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActor } from "../src/services/actors.js";
import { app } from "../src/api/app.js";

test("GET /git/identity returns git config user.name for the relay workdir", async () => {
  // Own the identity rather than reading the machine's. This used to point the
  // relay at process.cwd() and assert whatever `git config user.name` returned,
  // which throws outright on a CI runner where no identity is set — the test
  // depended on developer machine configuration rather than on the endpoint.
  const dir = mkdtempSync(join(tmpdir(), "relay-"));
  const workdir = mkdtempSync(join(tmpdir(), "gitid-"));
  const expected = "Identity Under Test";
  execFileSync("git", ["init", "-q"], { cwd: workdir });
  execFileSync("git", ["config", "user.name", expected], { cwd: workdir });

  const cfgPath = join(dir, "relay.json");
  writeFileSync(cfgPath, JSON.stringify({ workdir, agents: {} }));
  const prev = process.env.VIBEOPS_RELAY_CONFIG;
  process.env.VIBEOPS_RELAY_CONFIG = cfgPath;

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
