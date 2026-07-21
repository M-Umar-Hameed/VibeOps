import { apiFetch } from "./client.js";
export const git = {
  identity: () => apiFetch("/git/identity", {}) as Promise<{ name: string | null }>,
};
