import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { ContextMenu, type MenuItemSpec } from "../../components/ContextMenu.js";
import { formatStageDurations } from "../../lib/run-summary.js";

type RunHistoryPaneProps = {
  ticketRuns: any[];
  recoveryByTicket: Map<string, { resumable: boolean; reason: string }>;
  selectedTicketId: string | null;
  onResumeRun: (runId: string) => void;
};

export function RunHistoryPane({
  ticketRuns,
  recoveryByTicket,
  selectedTicketId,
  onResumeRun,
}: RunHistoryPaneProps) {
  const queryClient = useQueryClient();
  const [runMenu, setRunMenu] = useState<{ items: MenuItemSpec[]; x: number; y: number; label: string } | null>(null);

  if (ticketRuns.length === 0) return null;

  const buildRunItems = (run: any): MenuItemSpec[] => {
    const running = run.status === "running";
    const rec = recoveryByTicket.get(run.ticketId);
    const slot1: MenuItemSpec = running
      ? {
          key: "stop", label: "Stop run", danger: true,
          confirm: {
            title: "Stop this run?",
            message: "Halts the run now. The sandbox and any committed work are kept — this is not Discard. Work in progress is committed before the run stops.",
            confirmLabel: "Stop run",
          },
          onSelect: async () => {
            await api.post(`/forge/runs/${run.id}/stop`);
            queryClient.invalidateQueries({ queryKey: ["forge", "runs", run.ticketId] });
          },
        }
      : {
          key: "resume", label: "Resume run",
          disabled: !rec?.resumable,
          disabledReason: rec?.reason || "no resumable state for this run",
          onSelect: async () => {
            const res = await api.post(`/forge/tickets/${run.ticketId}/resume`) as { runId: string };
            queryClient.invalidateQueries({ queryKey: ["forge", "runs", run.ticketId] });
            queryClient.invalidateQueries({ queryKey: ["forge", "recovery"] });
            if (run.ticketId === selectedTicketId) onResumeRun(res.runId);
          },
        };
    const retry: MenuItemSpec = {
      key: "retry", label: "Retry from plan",
      disabled: running, disabledReason: "run in flight",
      confirm: {
        title: "Retry from the beginning?",
        message: "Starts a fresh run from the plan stage. The existing sandbox is not deleted.",
        confirmLabel: "Retry run",
      },
      onSelect: async () => {
        await api.post("/forge/pipeline", { ticketId: run.ticketId, planAgent: "auto", workAgent: "auto", reviewAgent: "auto", force: false });
        queryClient.invalidateQueries({ queryKey: ["forge", "runs", run.ticketId] });
        queryClient.invalidateQueries({ queryKey: ["forge", "tickets"] });
      },
    };
    return [slot1, retry];
  };

  const openRunMenu = (run: any, x: number, y: number) =>
    setRunMenu({ items: buildRunItems(run), x, y, label: `Actions for run ${run.id.substring(0, 8)}` });

  return (
    <>
      <div className="glass-card rounded-xl border border-white/10 p-6 flex flex-col gap-4">
        <h3 className="font-headline-sm text-on-surface font-bold border-b border-white/5 pb-2">Run History</h3>
        <div className="space-y-2">
          {ticketRuns.map(run => (
            <div
              key={run.id}
              onContextMenu={(e) => { e.preventDefault(); openRunMenu(run, e.clientX, e.clientY); }}
              className="relative flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border border-white/5 bg-surface-container-lowest rounded-lg p-3"
            >
              <button
                type="button"
                aria-label={`Actions for run ${run.id.substring(0, 8)}`}
                onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openRunMenu(run, r.right, r.bottom); }}
                className="absolute top-1 right-1 px-1 text-on-surface-variant hover:text-on-surface"
              >
                <span className="material-symbols-outlined text-lg">more_vert</span>
              </button>
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-code-sm text-sm text-on-surface">Run {run.id.substring(0, 8)}</span>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-code-label uppercase ${run.status === 'passed' ? 'bg-green-500/20 text-green-400' : run.status === 'failed' || run.status === 'rejected' ? 'bg-red-500/20 text-red-400' : 'bg-surface-container text-on-surface-variant'}`}>
                    {run.status}
                  </span>
                  {run.effort && (
                    <span data-testid={`run-effort-${run.id}`} className="px-2 py-0.5 rounded text-[10px] font-code-label uppercase border border-white/10 bg-surface-container text-on-surface-variant">
                      {run.effort}
                    </span>
                  )}
                </div>
                <span className="text-xs text-on-surface-variant/70 font-code-sm">
                  {new Date(run.startedAt).toLocaleString()}
                </span>
                {run.stageDurationsMs && formatStageDurations(run.stageDurationsMs) && (
                  <span data-testid={`run-stage-durations-${run.id}`} className="text-xs text-on-surface-variant/70 font-code-sm">
                    {formatStageDurations(run.stageDurationsMs)}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-right">
                <span className="text-xs text-on-surface-variant">
                  Plan: {run.agents?.plan || 'auto'} | Work: {run.agents?.work || 'auto'} | Review: {run.agents?.review || 'auto'}
                </span>
                {run.modelVerified === false ? (
                  <span className="px-2 py-0.5 border border-amber-500/30 bg-amber-500/10 text-amber-500 text-[10px] rounded font-code-label uppercase" title="Executed model did not match requested tier">
                    Mismatch
                  </span>
                ) : run.modelVerified === true ? (
                  <span className="px-2 py-0.5 border border-green-500/30 bg-green-500/10 text-green-400 text-[10px] rounded font-code-label uppercase">
                    Verified
                  </span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>
      {runMenu && <ContextMenu {...runMenu} onClose={() => setRunMenu(null)} />}
    </>
  );
}
