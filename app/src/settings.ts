import { load } from "@tauri-apps/plugin-store";
import { readTextFile, BaseDirectory } from "@tauri-apps/plugin-fs";
import { hasTauri } from "./lib/tauri.js";

export type Settings = { baseUrl: string; apiKey: string };
const FILE = "settings.json";

type ReadImpl = (path: string, opts: { baseDir: number }) => Promise<string>;
let readImpl: ReadImpl = readTextFile as unknown as ReadImpl;
export function setReadTextFileImpl(fn: ReadImpl) { readImpl = fn; }

// Read server-written first-run credentials; null when absent/unreadable/malformed.
export async function detectLocalNode(): Promise<Settings | null> {
  try {
    const raw = await readImpl(".vibeops/credentials.json", { baseDir: BaseDirectory.Home });
    const parsed = JSON.parse(raw);
    if (typeof parsed.baseUrl !== "string" || typeof parsed.apiKey !== "string" || !parsed.apiKey) return null;
    return { baseUrl: parsed.baseUrl, apiKey: parsed.apiKey };
  } catch {
    return null;
  }
}

export async function getSettings(): Promise<Settings> {
  if (!hasTauri()) {
    return {
      baseUrl: import.meta.env.VITE_API_BASE ?? "http://localhost:8787",
      apiKey: import.meta.env.VITE_API_KEY ?? "",
    };
  }
  const store = await load(FILE, { autoSave: false, defaults: {} });
  const baseUrl = (await store.get<string>("baseUrl")) ?? "http://localhost:8787";
  const apiKey = (await store.get<string>("apiKey")) ?? "";
  return { baseUrl, apiKey };
}

export async function saveSettings(s: Settings): Promise<void> {
  if (!hasTauri()) {
    throw new Error(
      "saveSettings is unavailable outside the desktop app; set VITE_API_BASE / VITE_API_KEY instead",
    );
  }
  const store = await load(FILE, { autoSave: false, defaults: {} });
  await store.set("baseUrl", s.baseUrl);
  await store.set("apiKey", s.apiKey);
  await store.save();
}
