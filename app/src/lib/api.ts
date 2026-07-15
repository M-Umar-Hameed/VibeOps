import { apiFetch } from "../api/client.js";

// Verb-style facade over apiFetch for the settings cards.
export const api = {
  get: (path: string) => apiFetch(path),
  post: (path: string, body?: unknown) => apiFetch(path, { method: "POST", body }),
  patch: (path: string, body?: unknown) => apiFetch(path, { method: "PATCH", body }),
  del: (path: string, body?: unknown) => apiFetch(path, { method: "DELETE", body }),
};
