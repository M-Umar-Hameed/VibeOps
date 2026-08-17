import { useSyncExternalStore } from "react";
import { QueryClient, type QueryKey } from "@tanstack/react-query";
import { queryClient } from "./queryClient.js";
import { getSettings } from "../settings.js";

export type EventType = "run.stage" | "run.settled" | "ticket.changed";

// One mapping table: event type -> query keys to invalidate. run.settled also
// refreshes recovery so its poller can retire while the stream is connected.
export const INVALIDATIONS: Record<EventType, QueryKey[]> = {
  "run.stage": [["forge", "runs"], ["forge", "tickets"]],
  "run.settled": [["forge", "runs"], ["forge", "tickets"], ["forge", "recovery"], ["tickets"]],
  "ticket.changed": [["tickets"], ["forge", "tickets"]],
};

export function applyInvalidation(client: QueryClient, type: EventType): void {
  for (const key of INVALIDATIONS[type] ?? []) client.invalidateQueries({ queryKey: key });
}

let connected = false;
const subs = new Set<() => void>();
function setConnected(v: boolean) {
  if (v === connected) return;
  connected = v;
  subs.forEach((f) => f());
}
function subscribe(cb: () => void) { subs.add(cb); return () => subs.delete(cb); }

export function useStreamConnected(): boolean {
  return useSyncExternalStore(subscribe, () => connected, () => false);
}

type ESImpl = new (url: string) => EventSource;
let ESImpl: ESImpl | undefined = (globalThis as { EventSource?: ESImpl }).EventSource;
export function setEventSourceImpl(impl: ESImpl) { ESImpl = impl; }

let es: EventSource | null = null;
let starting = false;

// Idempotent; app-lifetime stream (no stop on unmount). StrictMode double-mount
// is a no-op via the es/starting guard. No-op where EventSource is absent (jsdom).
export async function startEventStream(client: QueryClient = queryClient): Promise<void> {
  if (es || starting || !ESImpl) return;
  starting = true;
  try {
    const { baseUrl, apiKey } = await getSettings();
    if (es) return;
    es = new ESImpl(`${baseUrl}/events?access_token=${encodeURIComponent(apiKey)}`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false); // EventSource auto-reconnects; onopen re-fires
    for (const type of Object.keys(INVALIDATIONS) as EventType[]) {
      es.addEventListener(type, () => applyInvalidation(client, type));
    }
  } finally {
    starting = false;
  }
}

export function stopEventStream(): void {
  es?.close();
  es = null;
  starting = false;
  setConnected(false);
}
