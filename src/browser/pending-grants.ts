// Grant refusals issued by the MCP server, so a chat turn that ran a CLI agent
// can show the owner the same Allow prompt the SDK lane gets. In memory only;
// entries older than TTL are dropped on read.
export type Refusal = { actorId: string; origin: string; reason: string; at: number };
const TTL_MS = 30 * 60 * 1000;
const refusals: Refusal[] = [];

export function recordRefusal(actorId: string, origin: string, reason: string, now = Date.now()): void {
  refusals.push({ actorId, origin, reason, at: now });
}

// Returns and removes this actor's refusals recorded at or after `since`.
export function drainRefusals(actorId: string, since: number, now = Date.now()): Refusal[] {
  const keep: Refusal[] = [];
  const out: Refusal[] = [];
  for (const r of refusals) {
    if (now - r.at > TTL_MS) continue;
    if (r.actorId === actorId && r.at >= since) out.push(r); else keep.push(r);
  }
  refusals.length = 0;
  refusals.push(...keep);
  return out;
}
