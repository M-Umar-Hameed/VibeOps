import type { ActionStep } from "./channel.js";

// Local risk screen for act batches. It may only ever DENY: laya absent, a
// timeout, low confidence, or a benign verdict all return null, which leaves the
// existing grant decision untouched. A classifier must never be able to widen
// what the owner already allowed, only to narrow it.
const RISK_CONFIDENCE = 0.9;

// Same shape as forge.agentWall: present-and-"false" turns it off, anything else
// (including unset) leaves it on. The screen is inert anyway until laya.command
// is configured, so defaulting to on cannot surprise an install that has no laya.
async function screenEnabled(): Promise<boolean> {
  try {
    const { getSetting } = await import("../services/settings.js");
    return (await getSetting("laya.browserRiskScreen")) !== "false";
  } catch {
    return true; // no database (relay runner): the laya.command check still gates it
  }
}

// A compact, verb-first rendering. Page text is deliberately NOT included: it is
// untrusted content, and feeding it to the screen would let a page talk the
// screen into or out of a verdict.
export function describeSteps(steps: ActionStep[], origin: string): string {
  const lines = steps.map((s) => {
    const r = s as unknown as Record<string, unknown>;
    const verb = typeof r.verb === "string" ? r.verb : "unknown";
    const value = typeof r.value === "string" && r.value ? ` value=${r.value.slice(0, 80)}` : "";
    return `${verb}${value}`;
  });
  return `On ${origin}, perform: ${lines.join("; ")}`;
}

/**
 * Returns a refusal sentence when the batch should be blocked, or null to allow.
 * Null is the fail-open default on every error path.
 */
export async function actRiskRefusal(steps: ActionStep[], targetOrigin: string): Promise<string | null> {
  if (!steps.length) return null;
  if (!(await screenEnabled())) return null;
  const { layaBoolean } = await import("../laya/client.js");
  const risky = await layaBoolean(
    { request: describeSteps(steps, targetOrigin) },
    "is_irreversible_or_destructive",
    RISK_CONFIDENCE,
  );
  if (risky !== true) return null;
  return `This browser action was blocked by the local risk screen as irreversible or destructive on ${targetOrigin}. `
    + "Re-run it with a narrower set of steps if that is wrong, or turn the screen off by setting laya.browserRiskScreen to false.";
}
