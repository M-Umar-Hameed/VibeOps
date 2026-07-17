import { apiFetch } from "./client.js";
import type { Actor } from "./types.js";
export const actors = {
  list: () => apiFetch("/actors", {}) as Promise<Actor[]>,
  create: (input: { name: string; kind: "human" | "agent"; role?: "admin" | "member" }) =>
    apiFetch("/actors", { method: "POST", body: input }) as Promise<{ actor: Actor; apiKey: string }>,
  revoke: (id: string) => apiFetch(`/actors/${id}/revoke`, { method: "POST" }) as Promise<{ id: string; revoked: boolean }>,
};
