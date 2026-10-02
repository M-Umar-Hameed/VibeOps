type SandboxActionsProps = {
  viewDiff: boolean;
  onToggleViewDiff: () => void;
  lastVerdict?: string;
  runActiveForTicket: boolean;
  hasViolations: boolean;
  confirmApprove: boolean;
  confirmDiscard: boolean;
  promoting: boolean;
  isRejected: boolean;
  isSubmitting: boolean;
  onPromote: () => void;
  onApprove: () => void;
  onDiscard: () => void;
  onRework: () => void;
  gateOverridden: boolean;
  onOverrideGate: () => void;
};

export function SandboxActions({
  viewDiff,
  onToggleViewDiff,
  lastVerdict,
  runActiveForTicket,
  hasViolations,
  confirmApprove,
  confirmDiscard,
  promoting,
  isRejected,
  isSubmitting,
  onPromote,
  onApprove,
  onDiscard,
  onRework,
  gateOverridden,
  onOverrideGate,
}: SandboxActionsProps) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={onToggleViewDiff}
        className="px-4 py-2 rounded bg-surface-container-highest hover:bg-white/10 text-on-surface text-sm transition-all cursor-pointer"
      >
        {viewDiff ? "Hide diff" : "View diff"}
      </button>
      <button
        type="button"
        onClick={onPromote}
        disabled={lastVerdict !== "pass" || runActiveForTicket || hasViolations || promoting}
        title={
          promoting
            ? "Merging the sandbox into the project repository"
            : runActiveForTicket
              ? "Pipeline run in progress for this work order"
              : lastVerdict !== "pass"
                ? "Needs a passing review — inspect the diff, then use Approve override"
                : undefined
        }
        className="px-4 py-2 rounded bg-green-500/20 hover:bg-green-500/40 text-green-400 text-sm font-bold uppercase transition-all disabled:opacity-50 cursor-pointer"
      >
        Promote
      </button>
      {!hasViolations && lastVerdict !== "pass" && (
        <button
          type="button"
          onClick={onApprove}
          disabled={runActiveForTicket}
          title={runActiveForTicket ? "Pipeline run in progress for this work order" : undefined}
          className="px-4 py-2 rounded bg-amber-500/20 hover:bg-amber-500/40 text-amber-400 text-sm font-bold uppercase transition-all disabled:opacity-50 cursor-pointer"
        >
          {confirmApprove ? "Confirm approve?" : "Approve override"}
        </button>
      )}
      {!gateOverridden && (
        <button
          type="button"
          onClick={onOverrideGate}
          disabled={runActiveForTicket}
          title={runActiveForTicket ? "Pipeline run in progress for this work order" : "Downgrade every mechanical gate block to a warning for this and all later runs"}
          className="px-4 py-2 rounded bg-amber-500/20 hover:bg-amber-500/40 text-amber-400 text-sm font-bold uppercase transition-all disabled:opacity-50 cursor-pointer"
        >
          Override gate
        </button>
      )}
      <button
        type="button"
        onClick={onDiscard}
        disabled={runActiveForTicket || promoting}
        title={promoting ? "Merging the sandbox into the project repository" : runActiveForTicket ? "Pipeline run in progress for this work order" : "Deletes the sandbox branch and its commits"}
        className="px-4 py-2 rounded bg-error/20 hover:bg-error/40 text-error text-sm font-bold uppercase transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
      >
        {confirmDiscard ? "Confirm discard?" : "Discard"}
      </button>
      {isRejected && (
        <button
          type="button"
          onClick={onRework}
          disabled={runActiveForTicket || isSubmitting}
          title={runActiveForTicket ? "Pipeline run in progress for this work order" : "Rework the existing sandbox against the review findings"}
          className="px-4 py-2 rounded bg-primary/20 hover:bg-primary/40 text-primary text-sm font-bold uppercase transition-all disabled:opacity-50 cursor-pointer"
        >
          Continue
        </button>
      )}
    </div>
  );
}
