import type { Event } from "../api/types.js";

export function AuditTimeline({ events, actorName }: { events: Event[] | undefined; actorName: (id: string) => string }) {
  return (
    <div className="relative ml-4 space-y-8 before:absolute before:left-0 before:top-2 before:h-[calc(100%-8px)] before:w-[1px] before:bg-white/10">
      {events?.map((event, idx) => (
        <div key={event.id} className="relative pl-8">
          <div className={`absolute left-[-4px] top-1.5 w-2 h-2 rounded-full ${idx === 0 ? 'bg-primary shadow-[0_0_8px_rgba(0,219,233,0.8)]' : 'bg-white/20'}`}></div>
          <div className="flex flex-col sm:flex-row justify-between items-start gap-2">
            <div>
              <p className="font-body-sm font-semibold text-on-surface">
                {event.action}
              </p>
              <div className="text-on-surface-variant text-xs space-y-1 mt-1">
                {event.changes && Object.entries(event.changes).map(([k, v]) => (
                  <p key={k}>{k}: {String(v.from)} {"->"} {String(v.to)}</p>
                ))}
              </div>
              <p className="text-on-surface-variant text-[10px] mt-1 font-code-sm opacity-60">
                By {actorName(event.actorId)}
              </p>
            </div>
            <span className="font-code-sm text-[11px] opacity-40 shrink-0">
              {new Date(event.at).toLocaleString()}
            </span>
          </div>
        </div>
      ))}
      {(!events || events.length === 0) && (
        <p className="pl-8 text-on-surface-variant text-xs opacity-50 italic">No history available</p>
      )}
    </div>
  );
}
