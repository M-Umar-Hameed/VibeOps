import type { RelayConfig, ModelTier } from "../relay/config.js";

export type Pick = { agent: string; model?: string };
export type RoutingStrategy = "cheapest-first" | "quality-first" | "balanced";
export type WorkShape = { title: string; body?: string | null };
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

// Laya-assisted strategy choice. The pickers above stay pure and synchronous;
// only the strategy is decided here, so routing remains testable without a model.
//
// Fail-open by construction: no laya, low confidence, or no answer all return
// `base` unchanged, which is exactly today's behaviour. A local model choosing
// WHICH configured model runs cannot grant anything new - the candidate pairs
// come from the owner's own relay config either way.
//
// The question is deliberately a concrete, observable property. Measured on this
// checkpoint over eight hand-labelled tickets:
//   is_large_multi_file_change  7/8 correct, and its one miss sits at 0.60
//   is_complex                  right label but 0.51 confidence on hard work
//   requires_senior_engineer    0.93 confident and WRONG on hard work
//   complexity (3-way enum)     0.09-0.27 confidence, unusable
// Judgement-shaped questions ("needs a senior engineer") come back confidently
// wrong; grounded ones work. Keep this phrasing unless re-measured.
//
// At 0.75 that set yields six correct routes, two abstentions and no wrong
// routes. Abstaining costs nothing; routing hard work to the cheapest model
// would, which is why the floor stays high.
const SHAPE_CONFIDENCE = 0.75;

export async function resolveStrategy(base: RoutingStrategy, work: WorkShape): Promise<RoutingStrategy> {
  const text = `${work.title}

${work.body ?? ""}`.trim();
  if (!text) return base;
  try {
    const { getSetting } = await import("../services/settings.js");
    if ((await getSetting("laya.routing")) === "false") return base;
  } catch { /* no database: the laya.command check still gates this */ }
  const { layaBoolean } = await import("../laya/client.js");
  const large = await layaBoolean({ request: text.slice(0, 4000) }, "is_large_multi_file_change", SHAPE_CONFIDENCE);
  if (large === null) return base;
  return large ? "quality-first" : "cheapest-first";
}
