import { expect, test } from "vitest";
import { pickAgents, escalate, pairsForRole, type AgentModelPair } from "../src/forge/router.js";
import type { RelayConfig } from "../src/relay/config.js";

function config(): RelayConfig {
  return {
    workdir: "/tmp",
    agents: {
      multi: {
        cmd: ["multi", "{model}"],
        roles: ["plan", "work", "review"],
        models: [
          { name: "cheap-lo", tier: "cheap", quality: 2 },
          { name: "cheap-hi", tier: "cheap", quality: 4 },
          { name: "free-lo", tier: "free", quality: 1 },
          { name: "expensive-hi", tier: "expensive", quality: 5 },
        ],
      },
      plain: {
        cmd: ["plain"],
        roles: ["work"],
      },
    },
  };
}

test("pairsForRole: model-less agents default to tier cheap, quality 3", () => {
  const pairs = pairsForRole(config(), "work");
  const plain = pairs.find((p) => p.agent === "plain");
  expect(plain).toEqual({ agent: "plain", tier: "cheap", quality: 3 });
});

test("cheapest-first: lowest tier wins overall", () => {
  // "review" only has "multi" -> free-lo (tier free) beats every cheap/expensive model.
  const picks = pickAgents(config(), "cheapest-first");
  expect(picks.review).toEqual({ agent: "multi", model: "free-lo" });
});

test("cheapest-first tiebreak: same tier prefers higher quality", () => {
  const cfg: RelayConfig = {
    workdir: "/tmp",
    agents: {
      a: { cmd: ["a"], roles: ["plan", "work", "review"], models: [{ name: "a-lo", tier: "cheap", quality: 2 }] },
      b: { cmd: ["b"], roles: ["plan", "work", "review"], models: [{ name: "b-hi", tier: "cheap", quality: 4 }] },
    },
  };
  expect(pickAgents(cfg, "cheapest-first").plan).toEqual({ agent: "b", model: "b-hi" });
});

test("quality-first: highest quality wins, tier tiebreaks toward cheaper", () => {
  const picks = pickAgents(config(), "quality-first");
  expect(picks.plan).toEqual({ agent: "multi", model: "expensive-hi" });
});

test("quality-first tiebreak: same quality prefers the cheaper tier", () => {
  const cfg: RelayConfig = {
    workdir: "/tmp",
    agents: {
      a: { cmd: ["a"], roles: ["plan", "work", "review"], models: [{ name: "a-exp", tier: "expensive", quality: 4 }] },
      b: { cmd: ["b"], roles: ["plan", "work", "review"], models: [{ name: "b-cheap", tier: "cheap", quality: 4 }] },
    },
  };
  expect(pickAgents(cfg, "quality-first").plan).toEqual({ agent: "b", model: "b-cheap" });
});

test("balanced: plan/review use quality-first, work uses cheapest-first", () => {
  const picks = pickAgents(config(), "balanced");
  expect(picks.plan).toEqual({ agent: "multi", model: "expensive-hi" });
  expect(picks.review).toEqual({ agent: "multi", model: "expensive-hi" });
  expect(picks.work).toEqual({ agent: "multi", model: "free-lo" });
});

test("pickAgents defaults to balanced when no strategy given", () => {
  expect(pickAgents(config())).toEqual(pickAgents(config(), "balanced"));
});

test("pickAgents throws when no agent is configured for a role", () => {
  const cfg: RelayConfig = { workdir: "/tmp", agents: { a: { cmd: ["a"], roles: ["plan"] } } };
  expect(() => pickAgents(cfg, "balanced")).toThrow(/no agent configured for role "work"/);
});

const escalationPairs: AgentModelPair[] = [
  { agent: "multi", model: "cheap-lo", tier: "cheap", quality: 2 },
  { agent: "multi", model: "cheap-hi", tier: "cheap", quality: 4 },
  { agent: "multi", model: "expensive-hi", tier: "expensive", quality: 5 },
];

test("escalate: 0 or 1 prior FAILs keep the strategy pick", () => {
  const base = { agent: "multi", model: "cheap-lo" };
  expect(escalate(escalationPairs, base, 0)).toEqual(base);
  expect(escalate(escalationPairs, base, 1)).toEqual(base);
});

test("escalate: 2+ prior FAILs step up to the next-higher-quality pair", () => {
  const base = { agent: "multi", model: "cheap-lo" }; // quality 2
  expect(escalate(escalationPairs, base, 2)).toEqual({ agent: "multi", model: "cheap-hi" }); // quality 4
  expect(escalate(escalationPairs, base, 3)).toEqual({ agent: "multi", model: "cheap-hi" }); // no further stacking
});

test("escalate: already at the top pair is capped, not thrown", () => {
  const top = { agent: "multi", model: "expensive-hi" }; // quality 5, nothing higher
  expect(escalate(escalationPairs, top, 5)).toEqual(top);
});
