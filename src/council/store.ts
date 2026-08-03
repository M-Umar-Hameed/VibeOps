import { getSetting, setSetting } from "../services/settings.js";

const KEY = "council:sessions";

export async function loadCouncilSessions(): Promise<unknown[]> {
  const raw = await getSetting(KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveCouncilSessions(list: unknown[]): Promise<void> {
  await setSetting(KEY, JSON.stringify(list));
}
