import { eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { settings } from "../../src/db/schema.js";
import { hasOverride, getOverride, setOverride, clearOverride } from "../../src/services/settings.js";

export async function clearSetting(key: string): Promise<void> {
  await db.delete(settings).where(eq(settings.key, key));
}

// Overrides live in a per-worker in-memory overlay (src/services/settings.ts),
// never in the shared database, so a value set here cannot bleed into a test
// file running in parallel. getSetting reads the overlay first, so code under
// test in THIS worker still observes the override. Nesting restores the prior
// overlay entry, not the database.
// ponytail: overlay covers getSetting-based reads only; api_key keys whose
// effect is process.env (openai/anthropic/voyage/google) are not overlaid. No
// test overrides those today; add env sync here if one ever needs it.
export async function withSetting<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
  const had = hasOverride(key);
  const prior = had ? getOverride(key) : null;
  setOverride(key, value);
  try {
    return await fn();
  } finally {
    if (had) setOverride(key, prior);
    else clearOverride(key);
  }
}

export async function withSettings<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const keys = Object.keys(values);
  const had = new Map<string, boolean>();
  const priors = new Map<string, string | null>();
  for (const k of keys) { had.set(k, hasOverride(k)); priors.set(k, getOverride(k)); }
  for (const k of keys) setOverride(k, values[k]);
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (had.get(k)) setOverride(k, priors.get(k) ?? null);
      else clearOverride(k);
    }
  }
}
