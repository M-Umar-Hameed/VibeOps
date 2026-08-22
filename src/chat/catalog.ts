// Model catalog for http lanes: GET {baseUrl}/models on an OpenAI-compatible
// provider (OpenRouter). Cached per baseUrl so the roster route does not hit
// the provider on every picker open.
// ponytail: module-map cache with a 1h TTL; no invalidation UI - restart or
// wait if the provider adds a model mid-session.

const TTL_MS = 60 * 60 * 1000;
export const CATALOG_CACHE = new Map<string, { at: number; ids: string[] }>();

export async function fetchCatalog(baseUrl: string, apiKey: string): Promise<string[]> {
  const hit = CATALOG_CACHE.get(baseUrl);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ids;
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const ids = (body.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string");
    if (ids.length) CATALOG_CACHE.set(baseUrl, { at: Date.now(), ids });
    return ids;
  } catch {
    return []; // provider down != roster broken; picker just shows no models
  }
}
