import { EventEmitter } from "node:events";

export type EventType = "run.stage" | "run.settled" | "ticket.changed";

// Module-global singleton event bus for the /events SSE route. One listener is
// added per open EventSource; the forge screen opens exactly one, but reconnect
// churn and multiple tabs can stack a few, so lift the default 10-listener cap
// to a generous finite value (0/unlimited would hide a real leak).
export const events = new EventEmitter();
events.setMaxListeners(100);

export function emitEvent(type: EventType, payload: unknown): void {
  events.emit("event", { type, payload });
}
