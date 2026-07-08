import type { Event } from "../api/types.js";
export function AuditTimeline({ events, actorName }: { events: Event[]; actorName: (id: string) => string }) {
  return (
    <ul>
      {events.map((e) => (
        <li key={e.id}>
          <b>{actorName(e.actorId)}</b> {e.action} <i>{new Date(e.at).toLocaleString()}</i>
          {e.changes && <span> — {Object.entries(e.changes).map(([k, v]) => `${k}: ${String(v.from)}→${String(v.to)}`).join(", ")}</span>}
        </li>
      ))}
    </ul>
  );
}
