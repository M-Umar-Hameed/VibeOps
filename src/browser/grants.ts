import { getSetting, setSetting } from "../services/settings.js";

// Slice-3 grant model (ticket-pinned; overrides spec 1.7): { origin, mode }.
// Exact origin match after lowercasing — no wildcards, no tenant/actionType.
export type BrowserGrant = { origin: string; mode: "read" | "act" };

export async function hasActGrant(origin: string): Promise<boolean> {
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

