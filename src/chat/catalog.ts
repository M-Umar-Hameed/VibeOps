// Model catalog for http lanes: GET {baseUrl}/models on an OpenAI-compatible
// provider (OpenRouter). Cached per baseUrl so the roster route does not hit
// the provider on every picker open.
// ponytail: module-map cache with a 1h TTL; no invalidation UI - restart or
// wait if the provider adds a model mid-session.

export type CatalogModel = { id: string; tools: boolean; vision: boolean };

const TTL_MS = 60 * 60 * 1000;
export const CATALOG_CACHE = new Map<string, { at: number; models: CatalogModel[] }>();

export async function fetchCatalog(baseUrl: string, apiKey: string): Promise<CatalogModel[]> {
  const hit = CATALOG_CACHE.get(baseUrl);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.models;
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      data?: { id?: unknown; supported_parameters?: unknown; architecture?: { input_modalities?: unknown } }[];
    };
    const models = (body.data ?? [])
      .filter((m): m is { id: string; supported_parameters?: unknown; architecture?: { input_modalities?: unknown } } => typeof m.id === "string")
      .map((m) => ({
        id: m.id,
        tools: Array.isArray(m.supported_parameters) && m.supported_parameters.includes("tools"),
        vision: Array.isArray(m.architecture?.input_modalities) && m.architecture!.input_modalities!.includes("image"),
      }));
    if (models.length) CATALOG_CACHE.set(baseUrl, { at: Date.now(), models });
    return models;
  } catch {
    return []; // provider down != roster broken; picker just shows no models
  }
}
