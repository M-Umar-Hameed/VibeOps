import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RelayConfig } from "../src/relay/config.js";

// Mock runAgent in memory — no child processes. Pattern copied from council-rounds.test.ts.
vi.mock("../src/relay/invoke.js", () => ({
  runAgent: vi.fn(async (
    _agent: unknown, prompt: string, _workdir: string,
    onData?: (chunk: string) => void,
  ) => {
    const hasQa = prompt.includes('label="qa"');
    let out: string;
    if (prompt.includes("optimist")) {
      out = hasQa ? "believer view: fine idea (revised after answers)" : "believer view: fine idea";
    } else if (prompt.includes("realist")) {
      out = hasQa ? "investor view: fine idea (revised after answers)" : "investor view: fine idea";
    } else if (prompt.includes("roaster")) {
      out = hasQa ? "skeptic view: fine idea (revised after answers)" : "skeptic view: fine idea";
    } else {
      // Chairman: always GO to finish quickly
      out = "looks good\nRATING: 8/10\nDECISION: GO\nTITLE: Council test ticket\nSPEC:\nspec line 1\nspec line 2";
    }
    onData?.(out);
    return { ok: true, output: out };
  }),
  substituteCmd: vi.fn((cmd: string[], vars: Record<string, string>) =>
    cmd.map((part) =>
      Object.entries(vars).reduce((acc, [key, value]) => acc.split(`{${key}}`).join(value), part),
    ),
  ),
  killTree: vi.fn(() => Promise.resolve()),
}));

import { restoreCouncilSessions, getCouncil } from "../src/council/runs.js";
import { app } from "../src/api/app.js";
import { createActor } from "../src/services/actors.js";

function relayConfig(): RelayConfig {
  return {
    workdir: tmpdir(),
    agents: {
      fake: {
        cmd: ["node", "unused", "--model", "{model}"],
        roles: ["plan", "work", "review"],
        models: [{ name: "fast", tier: "free", quality: 2 }, { name: "smart", tier: "expensive", quality: 5 }],
      },
    },
  };
}

// The resume route builds its config from VIBEOPS_RELAY_CONFIG. Locally a
// developer's ~/.vibeops/relay.json papers over not setting it; CI has no such
// file and every route call 400s. Point the env at an on-disk fixture.
const relayConfigPath = join(mkdtempSync(join(tmpdir(), "council-resume-relay-")), "relay.json");
let prevRelayEnv: string | undefined;
beforeAll(() => {
  writeFileSync(relayConfigPath, JSON.stringify(relayConfig()));
  prevRelayEnv = process.env.VIBEOPS_RELAY_CONFIG;
  process.env.VIBEOPS_RELAY_CONFIG = relayConfigPath;
});
afterAll(() => {
  if (prevRelayEnv === undefined) delete process.env.VIBEOPS_RELAY_CONFIG;
  else process.env.VIBEOPS_RELAY_CONFIG = prevRelayEnv;
});

async function waitForStatus(id: string, statuses: string[], timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const c = getCouncil(id);
    if (statuses.includes(c.status)) return c as any;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${statuses.join("|")} — got ${JSON.stringify(getCouncil(id))}`);
}

describe("council resume", () => {
  it("AC3: resume failed chairman-stage session (personas done, only re-run chairman)", async () => {
    const { actor, apiKey } = await createActor({ name: `council-actor-${Date.now()}`, kind: "human", role: "admin" });
    const id = `test-chairman-failed-${Date.now()}`;

    // Seed a failed session where personas finished (personaRounds has entry for round 2)
    // but chairman died. qa is present from a prior round.
    await restoreCouncilSessions([{
      id,
      prompt: "test prompt long enough",
      status: "failed",
      round: 2,
      output: "",
      believer: "believer view: fine idea",
      investor: "investor view: fine idea",
      skeptic: "skeptic view: fine idea",
      personaRounds: [
        { round: 1, believer: "b1", investor: "i1", skeptic: "s1" },
        { round: 2, believer: "b2", investor: "i2", skeptic: "s2" },
      ],
      qa: [{ question: "q1", answer: "a1" }],
      startedAt: new Date().toISOString(),
    }]);

    // Resume via HTTP
    const h = { Authorization: `Bearer ${apiKey}` };
    const res = await app.request(`/council/${id}/resume`, { method: "POST", headers: h });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Wait for completion
    const final = await waitForStatus(id, ["decided"]);

    // personaRounds length should still be 2 — personas were NOT re-run
    expect(final.personaRounds).toHaveLength(2);
    // qa preserved
    expect(final.qa).toHaveLength(1);
    expect(final.qa[0].question).toBe("q1");
    // verdict present
    expect(final.decision).toBe("GO");
  });

  it("AC3: resume failed personas-stage session (re-run personas then chairman)", async () => {
    const { actor, apiKey } = await createActor({ name: `council-actor-${Date.now()}`, kind: "human", role: "admin" });
    const id = `test-personas-failed-${Date.now()}`;

    // Seed a failed session where round 2 personas died (personaRounds has only round 1)
    await restoreCouncilSessions([{
      id,
      prompt: "test prompt long enough",
      status: "failed",
      round: 2,
      output: "",
      believer: "believer view: stale",
      investor: "investor view: stale",
      skeptic: "skeptic view: stale",
      personaRounds: [
        { round: 1, believer: "b1", investor: "i1", skeptic: "s1" },
        // No round 2 entry — personas died
      ],
      qa: [{ question: "q1", answer: "a1" }],
      startedAt: new Date().toISOString(),
    }]);

    // Resume
    const h = { Authorization: `Bearer ${apiKey}` };
    const res = await app.request(`/council/${id}/resume`, { method: "POST", headers: h });
    expect(res.status).toBe(200);

    const final = await waitForStatus(id, ["decided"]);

    // personaRounds should now have 2 entries (round 2 was re-run)
    expect(final.personaRounds).toHaveLength(2);
    expect(final.personaRounds[1].round).toBe(2);
    // qa still preserved
    expect(final.qa).toHaveLength(1);
    // Personas should show "revised after answers" because qa exists
    expect(final.believer).toContain("revised after answers");
  });

  it("AC4: resume on decided session returns 409 with human-readable reason", async () => {
    const { actor, apiKey } = await createActor({ name: `council-actor-${Date.now()}`, kind: "human", role: "admin" });
    const id = `test-decided-${Date.now()}`;

    await restoreCouncilSessions([{
      id,
      prompt: "test prompt long enough",
      status: "decided",
      round: 1,
      output: "",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    }]);

    const h = { Authorization: `Bearer ${apiKey}` };
    const res = await app.request(`/council/${id}/resume`, { method: "POST", headers: h });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("decided");
  });

  it("AC4: resume on consumed session returns 409 with human-readable reason", async () => {
    const { actor, apiKey } = await createActor({ name: `council-actor-${Date.now()}`, kind: "human", role: "admin" });
    const id = `test-consumed-${Date.now()}`;

    await restoreCouncilSessions([{
      id,
      prompt: "test prompt long enough",
      status: "consumed",
      round: 1,
      output: "",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    }]);

    const h = { Authorization: `Bearer ${apiKey}` };
    const res = await app.request(`/council/${id}/resume`, { method: "POST", headers: h });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("consumed");
  });
});
