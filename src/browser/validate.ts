import type { ActionStep } from "./channel.js";

// Closed verb set is the structural injection defense (Epic C §1.5): a step is
// valid only if its verb is known AND its keys are EXACTLY the shape for that
// verb — no unknown verb, no missing field, no extra field. A page-derived
// string can never smuggle in an executable field, because every non-listed key
// is rejected before anything is enqueued.
const SHAPES: Record<string, Record<string, "string">> = {
  click: { ref: "string" },
  type: { ref: "string", text: "string" },
  select: { ref: "string", option: "string" },
  press: { key: "string" },
  snapshot: {},
  read: { ref: "string" },
};

export function validateSteps(
  steps: unknown,
): { ok: true; steps: ActionStep[] } | { ok: false; error: string } {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, error: "steps must be a non-empty array" };
  }
  for (const step of steps) {
    if (typeof step !== "object" || step === null || Array.isArray(step)) {
      return { ok: false, error: "each step must be an object" };
    }
    const s = step as Record<string, unknown>;
    if (typeof s.verb !== "string" || !(s.verb in SHAPES)) {
      return { ok: false, error: `unknown verb: ${String(s.verb)}` };
    }
    const shape = SHAPES[s.verb];
    const allowed = new Set(["verb", ...Object.keys(shape)]);
    for (const key of Object.keys(s)) {
      if (!allowed.has(key)) return { ok: false, error: `unexpected field "${key}" on ${s.verb} step` };
    }
    for (const [field, type] of Object.entries(shape)) {
      if (typeof s[field] !== type) return { ok: false, error: `${s.verb}.${field} must be a ${type}` };
    }
  }
  return { ok: true, steps: steps as ActionStep[] };
}
