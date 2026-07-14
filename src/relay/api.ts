import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RelayConfig } from "./config.js";
import type { Ticket, Comment } from "../db/schema.js";

function baseUrlFor(config: RelayConfig): string {
  return config.baseUrl ?? "http://127.0.0.1:8787";
}

function apiKeyFor(config: RelayConfig): string {
  if (config.apiKey) return config.apiKey;
  try {
    const raw = readFileSync(join(homedir(), ".vibeops", "credentials.json"), "utf-8");
    const key = JSON.parse(raw).apiKey;
    if (typeof key === "string" && key) return key;
  } catch {
    // fall through to the error below
  }
  throw new Error("no relay API key: set apiKey in relay.json or ensure ~/.vibeops/credentials.json exists");
}

async function req(config: RelayConfig, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${baseUrlFor(config)}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKeyFor(config)}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`relay api ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

export function listTickets(config: RelayConfig, status?: string): Promise<Ticket[]> {
  return req(config, `/tickets${status ? `?status=${encodeURIComponent(status)}` : ""}`);
}

export function getTicket(config: RelayConfig, id: string): Promise<Ticket> {
  return req(config, `/tickets/${id}`);
}

export function getComments(config: RelayConfig, id: string): Promise<Comment[]> {
  return req(config, `/tickets/${id}/comments`);
}

export async function updateTicket(
  config: RelayConfig, id: string, expectedVersion: number, patch: Record<string, unknown>,
): Promise<Ticket | { conflict: true }> {
  const res = await fetch(`${baseUrlFor(config)}/tickets/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKeyFor(config)}` },
    body: JSON.stringify({ expectedVersion, ...patch }),
  });
  if (res.status === 409) return { conflict: true };
  if (!res.ok) throw new Error(`relay api update ${id} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

export function addComment(config: RelayConfig, id: string, body: string, kind?: string): Promise<Comment> {
  return req(config, `/tickets/${id}/comments`, { method: "POST", body: JSON.stringify({ body, kind }) });
}

export async function getKnowledge(
  config: RelayConfig, q: string, limit = 5,
): Promise<{ content: string; citation: string }[]> {
  // Context is a bonus, not a dependency: an embedder hiccup (rate limit,
  // cold model) must not abort a plan/work pass.
  try {
    return await req(config, `/knowledge?q=${encodeURIComponent(q)}&limit=${limit}`);
  } catch (e) {
    console.warn(`knowledge lookup skipped: ${(e as Error).message}`);
    return [];
  }
}
