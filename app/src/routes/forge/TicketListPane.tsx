import { useState, memo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { WorkOrderComposer, modelOptionsForRole } from "../../components/WorkOrderComposer.js";
import { parseSel, type Ticket, type Agent } from "./types.js";

type TicketListPaneProps = {
  tickets: Ticket[];
  selectedTicketId: string | null;
  activeProjectId: string | null;
  agents: Agent[];
  workDefaultModel: string;
  planAgent: string;
  workAgent: string;
  reviewAgent: string;
  onSelectTicket: (t: Ticket) => void;
  onTicketCreated: (t: Ticket) => void;
  ticketsError: string;
};

export const TicketListPane = memo(function TicketListPane({
  tickets,
  selectedTicketId,
  activeProjectId,
  agents,
  workDefaultModel,
  planAgent,
  workAgent,
  reviewAgent,
  onSelectTicket,
  onTicketCreated,
  ticketsError,
}: TicketListPaneProps) {
  const queryClient = useQueryClient();
  const [cleaningSandboxes, setCleaningSandboxes] = useState(false);
  const [cleanupNote, setCleanupNote] = useState("");

  const handleCleanupSandboxes = async () => {
    setCleaningSandboxes(true);
    setCleanupNote("");
    try {
      const r = await api.post("/forge/sandboxes/cleanup") as { discarded: string[]; reclaimedBytes: number; orphans: string[] };
      const mb = (r.reclaimedBytes / 1_048_576).toFixed(1);
      setCleanupNote(r.discarded.length
        ? `Removed ${r.discarded.length} merged sandbox${r.discarded.length === 1 ? "" : "es"} (${mb} MB)${r.orphans.length ? `; ${r.orphans.length} orphan dir(s) need manual removal` : ""}`
        : "Nothing to clean - no merged sandboxes on disk");
    } catch (e: any) {
      setCleanupNote(e.message || "Cleanup failed");
    } finally {
      setCleaningSandboxes(false);
    }
  };

  const groups = {
    open: tickets.filter(t => t.status === "open"),
    planned: tickets.filter(t => t.status === "planned"),
    in_progress: tickets.filter(t => t.status === "in_progress"),
    review: tickets.filter(t => t.status === "review"),
  };

  return (
    <div className="w-80 border-r border-white/10 bg-surface-container/30 overflow-y-auto flex flex-col">
      <div className="p-4 border-b border-white/5 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="font-headline-sm text-on-surface font-bold">Forge Work Orders</h2>
            <p className="text-xs text-on-surface-variant/70 mt-1">Plan, run, and promote agent work per work order.</p>
          </div>
          <button
            type="button"
            title="Remove sandboxes of closed work orders whose branches are fully merged"
            aria-label="Clean up merged sandboxes"
            disabled={cleaningSandboxes}
            onClick={handleCleanupSandboxes}
            className="shrink-0 p-1.5 rounded text-on-surface-variant hover:text-on-surface hover:bg-white/5 transition-colors disabled:opacity-50"
          >
            <span className={`material-symbols-outlined text-[18px] ${cleaningSandboxes ? "animate-spin" : ""}`}>
              {cleaningSandboxes ? "refresh" : "cleaning_services"}
            </span>
          </button>
        </div>
        {cleanupNote && <p className="text-[11px] font-code-sm text-on-surface-variant/70">{cleanupNote}</p>}
        {!activeProjectId && (
          <p className="text-xs text-on-surface-variant/70">Select a project to create a work order.</p>
        )}
        <WorkOrderComposer
          submitDisabled={!activeProjectId}
          createTicket={({ title, body }) =>
            api.post("/tickets", { projectId: activeProjectId, title, body }) as Promise<Ticket>}
          modelOptions={modelOptionsForRole(agents, "work")}
          defaultModel={workDefaultModel}
          launchPipeline={(t, effort, work) => {
            const plan = parseSel(planAgent), workSel = parseSel(workAgent), review = parseSel(reviewAgent);
            const w = work ?? workSel;
            const body: Record<string, any> = {
              ticketId: t.id,
              planAgent: plan.agent, workAgent: w.agent, reviewAgent: review.agent,
              extraPrompt: "", force: false, effort,
            };
            if (plan.model) body.planModel = plan.model;
            if (w.model) body.workModel = w.model;
            if (review.model) body.reviewModel = review.model;
            return api.post("/forge/pipeline", body) as Promise<{ runId: string; doctorWarnings?: string[] }>;
          }}
          onCreated={async (t) => {
            await queryClient.invalidateQueries({ queryKey: ["forge", "tickets"] });
            onTicketCreated(t as Ticket);
          }}
        />
      </div>
      {ticketsError && <div className="text-error text-xs p-4">{ticketsError}</div>}
      <div className="flex-1 p-4 space-y-6">
        {Object.entries(groups).map(([status, list]) => (
          <div key={status} className="space-y-2">
            <h3 className="font-code-label text-code-label text-on-surface-variant uppercase tracking-widest">{status}</h3>
            <div className="space-y-2">
              {list.map(t => (
                <div
                  key={t.id}
                  onClick={() => onSelectTicket(t)}
                  className={`p-3 rounded border transition-colors cursor-pointer ${selectedTicketId === t.id ? 'bg-primary-fixed-dim/10 border-primary-fixed-dim text-primary' : 'bg-surface-container-lowest border-white/5 text-on-surface hover:border-white/20'}`}
                >
                  <div className="text-sm font-medium truncate">{t.title}</div>
                  {status === "review" && t.sandbox?.lastVerdict === "pass" && (
                    <div className="mt-2 text-[10px] font-code-label bg-green-500/20 text-green-400 px-2 py-1 rounded inline-block">PASS - awaiting promote</div>
                  )}
                </div>
              ))}
              {list.length === 0 && <div className="text-xs text-on-surface-variant/50 italic">None</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});
