type SandboxViolationAlertProps = {
  violations: string[];
  runActiveForTicket: boolean;
  onWaivePolicy: () => void;
};

export function SandboxViolationAlert({
  violations,
  runActiveForTicket,
  onWaivePolicy,
}: SandboxViolationAlertProps) {
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 space-y-3">
      <div className="text-sm font-bold text-amber-300">Protected-path policy violation</div>
      <div className="text-xs text-on-surface-variant">
        This run modified files that control how the project is built or tested. Allowing them unblocks promotion for this run only — the next run on any ticket is blocked again.
      </div>
      <ul className="text-xs font-code-label text-amber-200 list-disc pl-5">
        {violations.map((p) => <li key={p}>{p}</li>)}
      </ul>
      <button
        onClick={onWaivePolicy}
        disabled={runActiveForTicket}
        className="px-4 py-2 rounded bg-amber-500/20 hover:bg-amber-500/40 text-amber-300 text-sm font-bold uppercase transition-all disabled:opacity-50 cursor-pointer"
      >
        Allow for this run only
      </button>
    </div>
  );
}
