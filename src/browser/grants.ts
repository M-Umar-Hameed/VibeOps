import { getSetting } from "../services/settings.js";

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

export function noActGrantReason(origin: string): string {
  return `no act grant for ${origin} — add {"origin":"${origin}","mode":"act"} to browserGrants in Settings > Local Node`;
}
