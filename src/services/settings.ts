import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { settings } from "../db/schema.js";
import { invalidateCorsOrigins } from "./settings-cache.js";

// Test-only override overlay. Populated ONLY by the test helper
// (tests/helpers/settings.ts) so parallel test files, which share one database,
// cannot see each other's setting overrides. Module state => one map per vitest
// worker/fork, never shared across processes. Empty in production, so getSetting
// reads the database exactly as before there. setSetting and deleteSetting below
// are unchanged: production still persists to the database.
// An override bypasses setSetting, so it must invalidate the same read caches
// setSetting does. Without this a cached value (cors.origins) outlives the
// override and cached readers never observe it (Trap 1).
const overrides = new Map<string, string | null>();
function invalidateCaches(key: string): void {
  if (key === "cors.origins") invalidateCorsOrigins();
}
export function setOverride(key: string, value: string | null): void { overrides.set(key, value); invalidateCaches(key); }
export function hasOverride(key: string): boolean { return overrides.has(key); }
export function getOverride(key: string): string | null { return overrides.get(key) ?? null; }
export function clearOverride(key: string): void { overrides.delete(key); invalidateCaches(key); }

export async function getSetting(key: string): Promise<string | null> {
  if (overrides.has(key)) return overrides.get(key) ?? null;
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
  
  if (key === "cors.origins") invalidateCorsOrigins();
  if (key === "openai.api_key") process.env.OPENAI_API_KEY = value;
  if (key === "anthropic.api_key") process.env.ANTHROPIC_API_KEY = value;
  if (key === "voyage.api_key") process.env.VOYAGE_API_KEY = value;
  if (key === "voyage.model") process.env.EMBED_MODEL = value;
  if (key === "google.api_key") process.env.GEMINI_API_KEY = value;
}

export async function applyEnvSettings(): Promise<void> {
  const rows = await db.select({ key: settings.key, value: settings.value }).from(settings);
  for (const { key, value } of rows) {
    if (key === "openai.api_key") process.env.OPENAI_API_KEY = value;
    if (key === "anthropic.api_key") process.env.ANTHROPIC_API_KEY = value;
    if (key === "voyage.api_key") process.env.VOYAGE_API_KEY = value;
    if (key === "voyage.model") process.env.EMBED_MODEL = value;
    if (key === "google.api_key") process.env.GEMINI_API_KEY = value;
  }
}

export async function deleteSetting(key: string): Promise<void> {
  await db.delete(settings).where(eq(settings.key, key));
}
