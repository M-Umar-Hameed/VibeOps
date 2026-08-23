import { getSetting, setSetting } from "../services/settings.js";

// Slice-3 grant model (ticket-pinned; overrides spec 1.7): { origin, mode }.
// Exact origin match after lowercasing — no wildcards, no tenant/actionType.
export type BrowserGrant = { origin: string; mode: "read" | "act" };

async function hasPersistentActGrant(origin: string): Promise<boolean> {
  const raw = await getSetting("browserGrants");
  if (!raw) return false;
  let grants: unknown;
  try { grants = JSON.parse(raw); } catch { return false; }
  if (!Array.isArray(grants)) return false;
  const target = origin.toLowerCase();
  return grants.some(
    (g) =>
      g && typeof g === "object" &&
      typeof (g as any).origin === "string" &&
      (g as any).origin.toLowerCase() === target &&
      (g as any).mode === "act",
  );
}

// One-shot allowances: "Allow once" in chat. Keyed by session + origin, held
// in memory only (never written to browserGrants), consumed by the first act
// that uses one, expired after ONCE_TTL_MS unused. Restarting the sidecar
// forgets them, which is the safe direction.
export const ONCE_TTL_MS = 10 * 60 * 1000;
const once = new Map<string, number>(); // `${sessionId}\n${origin}` -> expiry epoch ms

export function allowOnce(sessionId: string, origin: string, now = Date.now()): void {
  once.set(`${sessionId}\n${origin.trim().toLowerCase()}`, now + ONCE_TTL_MS);
}

// True and CONSUMED when a live one-shot exists for this session + origin.
export function takeOnce(sessionId: string, origin: string, now = Date.now()): boolean {
  const k = `${sessionId}\n${origin.trim().toLowerCase()}`;
  const exp = once.get(k);
  if (exp === undefined) return false;
  once.delete(k);
  return exp > now;
}

export async function hasActGrant(origin: string, opts?: { sessionId?: string }): Promise<boolean> {
  if (await hasPersistentActGrant(origin)) return true;
  if (opts?.sessionId) return takeOnce(opts.sessionId, origin);
  return false;
}

// Append one act grant to the same browserGrants array Settings > Local Node edits.
// Lowercased + same-origin-deduped so hasActGrant's exact match sees it; other
// origins are left untouched (granting one origin never widens another).
export async function addActGrant(origin: string): Promise<void> {
  const o = origin.trim().toLowerCase();
  const raw = await getSetting("browserGrants");
  let grants: BrowserGrant[] = [];
  if (raw) {
    try { const g = JSON.parse(raw); if (Array.isArray(g)) grants = g; } catch { grants = []; }
  }
  const next = [
    ...grants.filter((g) => g && typeof g.origin === "string" && g.origin.toLowerCase() !== o),
    { origin: o, mode: "act" as const },
  ];
  await setSetting("browserGrants", JSON.stringify(next));
}

export function noActGrantReason(origin: string): string {
  return `no act grant for ${origin} — add {"origin":"${origin}","mode":"act"} to browserGrants in Settings > Local Node`;
}

