import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { NotFoundError } from "../../api/errors.js";
import { parseUnifiedDiff, type DiffFile } from "../../lib/diff-parse.js";
import { SandboxDiffViewer } from "./SandboxDiffViewer.js";
import { SandboxViolationAlert } from "./SandboxViolationAlert.js";
import { SandboxActions } from "./SandboxActions.js";
import type { Ticket, SandboxStatus, Diff } from "./types.js";

type SandboxPaneProps = {
  selectedTicket: Ticket;
  sandbox: SandboxStatus | null;
  sandboxQError: string;
  runStatus: string;
  runActiveForTicket: boolean;
  isSubmitting: boolean;
  ticketRuns: any[];
  onRework: () => void;
  selectedActivityFile: string | null;
  onActivityFileConsumed: () => void;
};

export function SandboxPane({
  selectedTicket,
  sandbox,
  sandboxQError,
  runStatus,
  runActiveForTicket,
  isSubmitting,
  ticketRuns,
  onRework,
  selectedActivityFile,
  onActivityFileConsumed,
}: SandboxPaneProps) {
  const queryClient = useQueryClient();
  const [diff, setDiff] = useState<string | null>(null);
  const [diffParsed, setDiffParsed] = useState<DiffFile[]>([]);
  const [sandboxError, setSandboxError] = useState("");
  const [viewDiff, setViewDiff] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState(false);

  useEffect(() => {
    if (sandbox && !sandbox.exists) {
      setDiff(null); setDiffParsed([]); setViewDiff(false);
    }
  }, [sandbox]);

  useEffect(() => {
    setSandboxError(""); setViewDiff(false); setDiff(null); setDiffParsed([]); setConfirmApprove(false);
  }, [selectedTicket.id]);

  useEffect(() => {
    if (selectedActivityFile) {
      setDiff(null); setDiffParsed([]); setViewDiff(true);
    }
  }, [selectedActivityFile]);

  useEffect(() => {
    if (viewDiff && selectedTicket && diff === null) {
      const path = runStatus === "running" ? `/forge/tickets/${selectedTicket.id}/diff?worktree=true` : `/forge/tickets/${selectedTicket.id}/diff`;
      api.get(path)
        .then(d => {
          const text = (d as Diff).diff;
          setDiff(text);
          if (text) setDiffParsed(parseUnifiedDiff(text).files);
        })
        .catch((e: any) => {
          if (e instanceof NotFoundError) setDiff("");
          else setSandboxError(e.message || "Failed to load diff");
        });
    }
  }, [viewDiff, selectedTicket, diff, runStatus]);

  const handlePromote = async () => {
    if (!selectedTicket) return;
    try {
      await api.post(`/forge/tickets/${selectedTicket.id}/promote`);
      await queryClient.invalidateQueries({ queryKey: ["forge", "tickets"] });
      await queryClient.invalidateQueries({ queryKey: ["forge", "sandbox", selectedTicket.id] });
    } catch (e: any) {
      setSandboxError(e.message || "Failed to promote");
    }
  };

  const handleApprove = async () => {
    if (!selectedTicket) return;
    if (!confirmApprove) { setConfirmApprove(true); return; }
    setConfirmApprove(false);
    try {
      await api.post(`/forge/tickets/${selectedTicket.id}/approve`);
      await queryClient.invalidateQueries({ queryKey: ["forge", "sandbox", selectedTicket.id] });
    } catch (e: any) {
      setSandboxError(e.message || "Failed to approve");
    }
  };

  const handleDiscard = async () => {
    if (!selectedTicket) return;
    try {
      await api.post(`/forge/tickets/${selectedTicket.id}/discard`);
      await queryClient.invalidateQueries({ queryKey: ["forge", "tickets"] });
      await queryClient.invalidateQueries({ queryKey: ["forge", "sandbox", selectedTicket.id] });
    } catch (e: any) {
      setSandboxError(e.message || "Failed to discard");
    }
  };

  const handleWaivePolicy = async () => {
    if (!selectedTicket || !sandbox?.protectedViolation) return;
    try {
      await api.post(`/forge/tickets/${selectedTicket.id}/waive-policy`, { paths: sandbox.protectedViolation });
      await queryClient.invalidateQueries({ queryKey: ["forge", "sandbox", selectedTicket.id] });
      await queryClient.invalidateQueries({ queryKey: ["tickets", selectedTicket.id, "comments"] });
    } catch (e: any) {
      setSandboxError(e.message || "Failed to waive policy");
    }
  };

  const hasViolations = (sandbox?.protectedViolation?.length ?? 0) > 0;

  return (
    <div className="glass-card rounded-xl border border-white/10 p-6 flex flex-col gap-4">
      <h3 className="font-headline-sm text-on-surface font-bold border-b border-white/5 pb-2">Sandbox</h3>
      {(sandboxQError || sandboxError) && <div className="text-error text-sm">{sandboxQError || sandboxError}</div>}
      
      {sandbox?.exists ? (
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <span className="text-sm text-on-surface-variant"><span className="font-bold text-on-surface">Branch:</span> {sandbox.branch}</span>
            <span className="text-sm text-on-surface-variant"><span className="font-bold text-on-surface">Verdict:</span> {sandbox.lastVerdict || "none"}</span>
          </div>

          <SandboxActions
            viewDiff={viewDiff}
            onToggleViewDiff={() => setViewDiff(!viewDiff)}
            lastVerdict={sandbox.lastVerdict}
            runActiveForTicket={runActiveForTicket}
            hasViolations={hasViolations}
            confirmApprove={confirmApprove}
            isRejected={ticketRuns[0]?.status === "rejected"}
            isSubmitting={isSubmitting}
            onPromote={handlePromote}
            onApprove={handleApprove}
            onDiscard={handleDiscard}
            onRework={onRework}
          />

          {hasViolations && (
            <SandboxViolationAlert
              violations={sandbox.protectedViolation!}
              runActiveForTicket={runActiveForTicket}
              onWaivePolicy={handleWaivePolicy}
            />
          )}
          {!hasViolations && sandbox.lastVerdict !== "pass" && (
            <div className="text-xs text-on-surface-variant">
              Promote unlocks after a passing review. Approve override records YOUR passing review on the ticket, then Promote merges.
            </div>
          )}

          {viewDiff && diff === "" && (
            <div className="p-4 bg-background/80 text-on-surface-variant italic border border-white/10 rounded-lg text-sm text-center">
              No sandbox / no changes yet
            </div>
          )}

          {viewDiff && diff && diff !== "" && (
            <SandboxDiffViewer
              ticketId={selectedTicket.id}
              diff={diff}
              diffParsed={diffParsed}
              selectedActivityFile={selectedActivityFile}
              onActivityFileConsumed={onActivityFileConsumed}
              onError={setSandboxError}
            />
          )}
        </div>
      ) : (
        <div className="p-8 text-center text-on-surface-variant border border-white/10 rounded-lg bg-surface-container-highest/50 border-dashed">
          Sandbox not created yet. Run the pipeline to generate code.
        </div>
      )}
    </div>
  );
}
