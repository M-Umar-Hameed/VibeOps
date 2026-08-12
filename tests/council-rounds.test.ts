import { describe, it, expect, vi, beforeAll } from "vitest";
import { tmpdir } from "node:os";
import type { RelayConfig } from "../src/relay/config.js";

// (h) moved from council-engine.test.ts and de-integrated. The original spawned
// 8 real node persona/chairman processes across two rounds and needed a raised
// 60s timeout to survive full-suite CPU contention. runAgent is mocked in memory:
// the orchestration under test (personas re-run each round, all three shift after
// answers, personaRounds accumulates) runs with zero child processes — determin-
// istic, no raised timeout. Routing mirrors fixtures/fake-agent.mjs.

// The path here is relative to THIS test file. Vitest hoists this mock above
// all imports, so council/runs.js will receive the mocked version.
vi.mock("../src/relay/invoke.js", () => ({
  runAgent: vi.fn(async (
    _agent: unknown, prompt: string, _workdir: string,
    onData?: (chunk: string) => void,
  ) => {
    // Prompt contains persona role keyword in PERSONA_ROLE text:
    //   optimist → believer, realist → investor, roaster → skeptic
    // Round 2 persona prompts also include label="qa" fence from Q&A context.
    // Chairman prompts include persona output text ("believer view...") but not
    // the role keywords themselves.
    const hasQa = prompt.includes('label="qa"');
    let out: string;
    if (prompt.includes("optimist")) {
      out = hasQa ? "believer view: fine idea (revised after answers)" : "believer view: fine idea";
    } else if (prompt.includes("realist")) {
      out = hasQa ? "investor view: fine idea (revised after answers)" : "investor view: fine idea";
    } else if (prompt.includes("roaster")) {
      out = hasQa ? "skeptic view: fine idea (revised after answers)" : "skeptic view: fine idea";
    } else {
      // Chairman: round 1 has no qa → NEEDS-INFO; round 2 has qa → GO
      out = hasQa
        ? "looks good\nRATING: 8/10\nDECISION: GO\nTITLE: Council test ticket\nSPEC:\nspec line 1\nspec line 2"
        : "need info\nRATING: 5/10\nDECISION: NEEDS-INFO\nQUESTIONS:\n- q1\n- q2\nTITLE: Council test ticket\nSPEC:\nspec line 1";
    }
    onData?.(out);
    return { ok: true, output: out };
  }),
  // Other exports from invoke.js that might be used
  substituteCmd: vi.fn((cmd: string[], vars: Record<string, string>) =>
    cmd.map((part) =>
      Object.entries(vars).reduce((acc, [key, value]) => acc.split(`{${key}}`).join(value), part),
    ),
  ),
  killTree: vi.fn(() => Promise.resolve()),
}));

import { startCouncil, getCouncil, submitAnswers } from "../src/council/runs.js";
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

async function waitForStatus(id: string, statuses: string[], timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const c = getCouncil(id);
    if (statuses.includes(c.status)) return c as any;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${statuses.join("|")} — got ${JSON.stringify(getCouncil(id))}`);
}

describe("council rounds", () => {
  it("(h) personas re-run each round: all three change after answers", async () => {
    const { actor } = await createActor({ name: `council-actor-${Date.now()}`, kind: "human" });

    const { councilId } = await startCouncil(actor.id, relayConfig(), { prompt: "a prompt long enough to pass" });
    const r1 = await waitForStatus(councilId, ["awaiting-answers"]);
    const before = { believer: r1.believer, investor: r1.investor, skeptic: r1.skeptic };

    await submitAnswers(councilId, relayConfig(), ["ans a", "ans b"]);
    const r2 = await waitForStatus(councilId, ["decided"]);

    expect(r2.believer).not.toBe(before.believer);
    expect(r2.investor).not.toBe(before.investor);
    expect(r2.skeptic).not.toBe(before.skeptic);
    expect(r2.believer).toContain("revised after answers");
    expect(r2.personaRounds).toHaveLength(2);
    expect(r2.personaRounds[0].round).toBe(1);
    expect(r2.personaRounds[1].round).toBe(2);
  });
});
