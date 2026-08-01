import { eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { settings } from "../../src/db/schema.js";
import { getSetting, setSetting } from "../../src/services/settings.js";

export async function clearSetting(key: string): Promise<void> {
  await db.delete(settings).where(eq(settings.key, key));
}

async function restore(key: string, prior: string | null): Promise<void> {
  if (prior === null) await clearSetting(key);
  else await setSetting(key, prior);
}

export async function withSetting<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
  const prior = await getSetting(key);
  await setSetting(key, value);
  try {
    return await fn();
  } finally {
    await restore(key, prior);
  }
}

export async function withSettings<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const keys = Object.keys(values);
  const priors = new Map<string, string | null>();
  for (const k of keys) priors.set(k, await getSetting(k));
  for (const k of keys) await setSetting(k, values[k]);
  try {
    return await fn();
  } finally {
    for (const k of keys) await restore(k, priors.get(k) ?? null);
  }
}
