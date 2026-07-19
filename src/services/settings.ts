import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { settings } from "../db/schema.js";

export async function getSetting(key: string): Promise<string | null> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
  
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
