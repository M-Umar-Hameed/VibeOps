import type { RelayConfig, ModelTier } from "../relay/config.js";

export type Pick = { agent: string; model?: string };
export type RoutingStrategy = "cheapest-first" | "quality-first" | "balanced";
export type AgentModelPair = Pick & { tier: ModelTier; quality: number };

type Role = "plan" | "work" | "review";

const TIER_ORDER: Record<ModelTier, number> = { free: 0, cheap: 1, expensive: 2 };

// One pair per (agent, model); a model-less agent contributes one pair with
// default tier/quality so it still competes in strategy ordering.
export function pairsForRole(config: RelayConfig, role: Role): AgentModelPair[] {
  const pairs: AgentModelPair[] = [];
  for (const [name, agent] of Object.entries(config.agents)) {
    if (!agent.roles.includes(role)) continue;
    if (agent.models?.length) {
      for (const m of agent.models) pairs.push({ agent: name, model: m.name, tier: m.tier, quality: m.quality });
    } else {
      pairs.push({ agent: name, tier: "cheap", quality: 3 });
    }
  }
  return pairs;
}

function cheapestFirst(pairs: AgentModelPair[]): AgentModelPair {
  return [...pairs].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.quality - a.quality)[0];
}

function qualityFirst(pairs: AgentModelPair[]): AgentModelPair {
  return [...pairs].sort((a, b) => b.quality - a.quality || TIER_ORDER[a.tier] - TIER_ORDER[b.tier])[0];
}

function pickForRole(config: RelayConfig, role: Role, strategy: RoutingStrategy): Pick {
  const pairs = pairsForRole(config, role);
  if (!pairs.length) throw new Error(`no agent configured for role "${role}"`);
  const useCheapest = strategy === "cheapest-first" || (strategy === "balanced" && role === "work");
  const chosen = useCheapest ? cheapestFirst(pairs) : qualityFirst(pairs);
  return { agent: chosen.agent, model: chosen.model };
}

export function pickAgents(
  config: RelayConfig, strategy: RoutingStrategy = "balanced",
): { plan: Pick; work: Pick; review: Pick } {
  return {
    plan: pickForRole(config, "plan", strategy),
    work: pickForRole(config, "work", strategy),
    review: pickForRole(config, "review", strategy),
  };
}

// Rework is repeatedly failing -> step up to the next-higher-quality pair
// once. Capped: no pair beats the current one, or attempts < 2, keep basePick.
export function escalate(pairs: AgentModelPair[], basePick: Pick, attempts: number): Pick {
  if (attempts < 2) return basePick;
  const base = pairs.find((p) => p.agent === basePick.agent && p.model === basePick.model);
  const baseQuality = base?.quality ?? 0;
  const higher = pairs.filter((p) => p.quality > baseQuality).sort((a, b) => a.quality - b.quality);
  if (!higher.length) return basePick;
  return { agent: higher[0].agent, model: higher[0].model };
}
