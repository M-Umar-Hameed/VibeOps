import { resolve } from "node:path";
import type { RelayAccount } from "./config.js";
import { redactSecrets } from "../forge/redact.js";

export type AccountState = { exhaustedUntil?: string; lastError?: string; lastUsed?: string };
const DEFAULT_COOLDOWN_MS = 60 * 60_000;

// One settings row per login folder: two lanes on one folder (claude + claude-sdk)
// share one subscription limit. DB-backed so it survives a server restart.
export function stateKey(configDir: string): string {
  const p = resolve(configDir);
  return `relay.accountState.${process.platform === "win32" ? p.toLowerCase() : p}`;
}

export function resolveCooldownMs(raw: string | null): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_COOLDOWN_MS;
}

// Dynamic import + fail-open like wall.ts: a DB hiccup must never block a run.
export async function readAccountState(configDir: string): Promise<AccountState> {
  try {
    const { getSetting } = await import("../services/settings.js");
    const raw = await getSetting(stateKey(configDir));
    return raw ? (JSON.parse(raw) as AccountState) : {};
  } catch { return {}; }
}

async function writeAccountState(configDir: string, patch: AccountState): Promise<void> {
  try {
    const { setSetting } = await import("../services/settings.js");
    await setSetting(stateKey(configDir), JSON.stringify({ ...(await readAccountState(configDir)), ...patch }));
  } catch (e) { console.warn(`relay: account state write failed: ${(e as Error).message}`); }
}

// Exhausted until the CLI's reset time, else forge.accountCooldownMs (default 1h) from now.
export async function markExhausted(acct: RelayAccount, resetAt: Date | undefined, error: string, now = new Date()): Promise<Date> {
  let until = resetAt;
  if (!until) {
    let raw: string | null = null;
    try { raw = await (await import("../services/settings.js")).getSetting("forge.accountCooldownMs"); } catch { /* default */ }
    until = new Date(now.getTime() + resolveCooldownMs(raw));
  }
  await writeAccountState(acct.configDir, { exhaustedUntil: until.toISOString(), lastError: redactSecrets(error.slice(-500)) });
  return until;
}

export async function markUsed(acct: RelayAccount, now = new Date()): Promise<void> {
  await writeAccountState(acct.configDir, { lastUsed: now.toISOString() });
}
