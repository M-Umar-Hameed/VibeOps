import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import type { Ticket } from "./types.js";

type TicketHeaderProps = {
  selectedTicket: Ticket;
  runActiveForTicket: boolean;
  onTicketUpdated: (t: Ticket) => void;
};

export function TicketHeader({ selectedTicket, runActiveForTicket, onTicketUpdated }: TicketHeaderProps) {
  const queryClient = useQueryClient();
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusError, setStatusError] = useState("");

  const handleStatusChange = async (newStatus: string) => {
    setStatusSaving(true);
    setStatusError("");
    try {
      const updated = await api.patch(`/tickets/${selectedTicket.id}`, {
        expectedVersion: selectedTicket.version,
        status: newStatus,
      });
      onTicketUpdated(updated as Ticket);
      await queryClient.invalidateQueries({ queryKey: ["forge", "tickets"] });
    } catch (e: any) {
      setStatusError(e.message || "Failed to update status");
    } finally {
      setStatusSaving(false);
    }
  };

  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="font-headline-md text-primary font-bold">{selectedTicket.title}</h2>
        <div className="text-xs text-on-surface-variant font-code-sm mt-1">Ticket ID: {selectedTicket.id}</div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {statusError && <span className="text-error text-[10px]">{statusError}</span>}
        {(selectedTicket.status === "planned" || selectedTicket.status === "review") ? (
          <span className="px-2 py-0.5 rounded border font-code-sm text-[10px] uppercase tracking-wider border-secondary/30 bg-secondary/10 text-secondary">
            {selectedTicket.status}
          </span>
        ) : (
          <select
            aria-label="Ticket status"
            className="bg-transparent text-primary-fixed-dim text-xs font-code-label uppercase outline-none cursor-pointer hover:bg-white/5 rounded px-2 py-1 disabled:opacity-50 disabled:cursor-not-allowed"
            value={selectedTicket.status}
            disabled={runActiveForTicket || statusSaving}
            title={runActiveForTicket ? "Pipeline run in progress for this ticket" : undefined}
            onChange={(e) => handleStatusChange(e.target.value)}
          >
            <option className="bg-surface text-on-surface" value="open">OPEN</option>
            <option className="bg-surface text-on-surface" value="in_progress">IN_PROGRESS</option>
            <option className="bg-surface text-on-surface" value="closed">CLOSED</option>
          </select>
        )}
      </div>
    </div>
  );
}
