import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { getSettings, type Settings } from "../settings.js";
import { ApiError, AuthError, NotFoundError, StaleVersionError } from "./errors.js";
import { hasTauri } from "../lib/tauri.js";

type FetchImpl = typeof tauriFetch;
let fetchImpl: FetchImpl = hasTauri()
  ? tauriFetch
  : (globalThis.fetch.bind(globalThis) as unknown as FetchImpl);
let settingsImpl: () => Promise<Settings> = getSettings;
export function setFetchImpl(f: FetchImpl) { fetchImpl = f; }
export function setSettingsImpl(f: () => Promise<Settings>) { settingsImpl = f; }

export async function apiFetch(
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {},
): Promise<any> {
  const { baseUrl, apiKey } = await settingsImpl();
  const qs = init.query
    ? "?" + Object.entries(init.query).filter(([, v]) => v != null)
        .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`).join("&")
    : "";
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}${path}${qs}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: init.body != null ? JSON.stringify(init.body) : undefined,
    });
  } catch (e) {
    throw new ApiError(`cannot reach server: ${(e as Error).message}`, 0, true);
  }
  if (res.ok) return res.status === 204 ? null : res.json();
  const msg = await res.json().then((b) => b.error).catch(() => res.statusText);
  if (res.status === 401) throw new AuthError(msg);
  if (res.status === 404) throw new NotFoundError(msg);
  if (res.status === 409) throw new StaleVersionError(msg);
  throw new ApiError(msg, res.status);
}
