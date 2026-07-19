import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { tickets } from "../api/tickets.js";
import { StaleVersionError } from "../api/errors.js";

type Ticket = { id: string; title: string; status: string; body: string | null; version: number };

export function SpecEditor({ ticket, onSave }: { ticket: Ticket; onSave?: (t: Ticket) => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(ticket.body || "");
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);

  const isReadOnly = ticket.status === "in_progress" || ticket.status === "review";

  const save = useMutation({
    mutationFn: () => tickets.update(ticket.id, ticket.version, { body }),
    onSuccess: (updatedTicket) => {
      setConflict(false);
      setError("");
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["ticket", ticket.id] });
      qc.invalidateQueries({ queryKey: ["history", ticket.id] });
      if (onSave) onSave(updatedTicket as any);
    },
    onError: (e) => {
      if (e instanceof StaleVersionError) {
        setConflict(true);
        qc.invalidateQueries({ queryKey: ["ticket", ticket.id] });
      } else {
        setError(e instanceof Error ? e.message : "Failed to save spec");
      }
    },
  });

  const displayBody = ticket.body || "";

  if (editing) {
    return (
      <div className="glass-card p-6 rounded-xl space-y-4">
        {conflict && <div className="bg-error-container/20 border border-error p-4 rounded text-error text-sm font-code-sm">This ticket changed elsewhere — reloaded; please redo your edit and save again.</div>}
        {error && <div className="bg-error-container/20 border border-error p-4 rounded text-error text-sm font-code-sm">{error}</div>}
        <textarea
          className="w-full bg-surface-container-lowest border border-white/10 rounded-xl p-4 text-sm text-on-surface focus:border-primary-fixed-dim focus:ring-1 focus:ring-primary-fixed-dim/30 outline-none transition-all min-h-[200px] resize-y"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="flex gap-2 justify-end">
          <button onClick={() => { setEditing(false); setBody(ticket.body || ""); setConflict(false); setError(""); }} className="px-4 py-2 text-sm text-on-surface hover:bg-white/5 rounded">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending} className="px-4 py-2 text-sm bg-primary text-on-primary rounded font-bold">Save</button>
        </div>
      </div>
    );
  }

  const lines = displayBody.split("\n");
  const isLong = lines.length > 6;
  const showText = (!expanded && isLong) ? lines.slice(0, 6).join("\n") + "\n..." : displayBody;

  return (
    <div className="glass-card p-6 rounded-xl space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-primary-fixed-dim">
          <span className="material-symbols-outlined text-base">description</span>
          <h3 className="font-headline-md text-headline-md">Spec</h3>
        </div>
        {!isReadOnly ? (
          <button onClick={() => { setEditing(true); setBody(ticket.body || ""); }} className="text-xs text-primary hover:underline uppercase font-bold tracking-wider cursor-pointer">Edit Spec</button>
        ) : (
          <span className="text-xs text-on-surface-variant italic" title="Read-only because a run has already consumed the spec">Read-only (in pipeline)</span>
        )}
      </div>
      {displayBody ? (
        <div className="text-sm text-on-surface-variant leading-relaxed font-body-sm whitespace-pre-wrap">
          {showText}
        </div>
      ) : (
        <span className="opacity-50 italic text-sm text-on-surface-variant">No spec provided.</span>
      )}
      {!editing && isLong && (
        <button onClick={() => setExpanded(!expanded)} className="text-xs text-primary mt-2 hover:underline cursor-pointer">
          {expanded ? "Collapse" : "Expand"}
        </button>
      )}
    </div>
  );
}
