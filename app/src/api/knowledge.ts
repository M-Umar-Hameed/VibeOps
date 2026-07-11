import { apiFetch } from "./client.js";
import type { Hit } from "./types.js";
export const knowledge = {
  search: (q: string, limit?: number) =>
    apiFetch("/knowledge", { query: { q, limit: limit?.toString() } }) as Promise<Hit[]>,
  getSource: (kind: string, ref: string) =>
    apiFetch("/knowledge/source", { query: { kind, ref } }) as Promise<{ text: string }>,
};
