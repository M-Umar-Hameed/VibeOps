import { memo } from "react";
import { stageLabel, parseChecks, elapsedLabel, failureLine } from "../../lib/run-summary.js";
import { OutputPane } from "../../components/OutputPane.js";
import type { SandboxActivityData } from "./types.js";

type RunStatusPaneProps = {
  activeRunId: string | null;
  runChunks: string[];
  runOutput: string;
  runStage: string;
  runStatus: string;
  runError: string;
  outputUnavailable: boolean;
  showDetails: boolean;
  setShowDetails: React.Dispatch<React.SetStateAction<boolean>>;
  runStartedAt: number | null;
  nowMs: number;
  sandboxActivity: SandboxActivityData | null;
  rejectionReason?: string;
  onOpenActivityFile: (path: string) => void;
};

export const RunStatusPane = memo(function RunStatusPane({
  activeRunId,
  runChunks,
  runOutput,
  runStage,
  runStatus,
  runError,
  outputUnavailable,
  showDetails,
  setShowDetails,
  runStartedAt,
  nowMs,
  sandboxActivity,
  rejectionReason,
  onOpenActivityFile,
}: RunStatusPaneProps) {
  const showRunStatus = !!(activeRunId || runOutput || outputUnavailable);
  const showSandboxActivity = runStatus === "running" && !!sandboxActivity;

  if (!showRunStatus && !showSandboxActivity) return null;

  const checks = parseChecks(runOutput);
  const fail = failureLine(runStatus, runError);
  const fileCount = sandboxActivity?.files?.length ?? 0;
  const reviewChecksPending = runStatus === "running" && runStage === "review" && checks.length === 0;

  return (
    <>
      {showRunStatus && (
        <div className="glass-card rounded-xl border border-white/10 overflow-hidden flex flex-col">
          <div className="p-3 bg-surface-container/50 border-b border-white/5 flex items-center justify-between">
            <span className="font-code-sm text-xs text-on-surface-variant uppercase tracking-widest">Run status</span>
            {activeRunId && <span className="w-2 h-2 rounded-full bg-secondary animate-pulse" />}
          </div>
          <div className="p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <div>
                <span className="text-on-surface-variant">Stage: </span>
                <span className="text-on-surface font-medium" data-testid="run-stage-label">{stageLabel(runStage)}</span>
              </div>
              {runStatus === "running" && runStartedAt !== null && (
                <div>
                  <span className="text-on-surface-variant">Elapsed: </span>
                  <span className="text-on-surface font-medium" data-testid="run-elapsed">{elapsedLabel(runStartedAt, nowMs)}</span>
                </div>
              )}
              <div>
                <span className="text-on-surface-variant">Files changed: </span>
                <span className="text-on-surface font-medium" data-testid="run-file-count">{fileCount}</span>
                {sandboxActivity && (fileCount > 0) && (
                  <span className="ml-2 font-code-sm text-xs">
                    <span className="text-green-400">+{sandboxActivity.totalAdditions ?? 0}</span>{" "}
                    <span className="text-red-400">-{sandboxActivity.totalDeletions ?? 0}</span>
                  </span>
                )}
              </div>
            </div>

            {(checks.length > 0 || reviewChecksPending) && (
              <div className="flex flex-wrap items-center gap-2" data-testid="run-checks">
                <span className="text-on-surface-variant text-sm">Checks:</span>
                {reviewChecksPending ? (
                  <span className="text-on-surface-variant text-sm italic animate-pulse">running...</span>
                ) : checks.map((ck) => (
                  <span
                    key={ck.command}
                    className={`px-2 py-0.5 rounded text-[10px] font-code-label uppercase ${ck.code === 0 ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}
                  >
                    {ck.command} {ck.code === 0 ? "pass" : "fail"}
                  </span>
                ))}
              </div>
            )}

            {runStatus === "rejected" && rejectionReason && (
              <div className="text-sm text-on-surface font-medium" data-testid="run-reason">
                <span className="font-bold text-error">Rejected: </span>{rejectionReason}
              </div>
            )}
            {fail && (
              <div className="text-sm text-error" data-testid="run-failure-line">{fail}</div>
            )}

            <button
              type="button"
              onClick={() => setShowDetails((s) => !s)}
              className="text-xs uppercase tracking-widest text-on-surface-variant hover:text-on-surface cursor-pointer"
            >
              {showDetails ? "Hide details" : "Show details"}
            </button>
            {showDetails && (
              outputUnavailable ? (
                <div className="p-4 text-on-surface-variant italic text-sm">view previous run output unavailable after restart</div>
              ) : (
                <OutputPane chunks={runChunks} />
              )
            )}
          </div>
        </div>
      )}

      {showSandboxActivity && sandboxActivity && (
        <div className="glass-card rounded-xl border border-white/10 p-6 flex flex-col gap-4">
          <div className="flex items-center justify-between border-b border-white/5 pb-2">
            <h3 className="font-headline-sm text-on-surface font-bold">Sandbox activity</h3>
            <div className="flex items-center gap-2">
              <span className="text-xs font-code-sm">
                <span className="text-green-400">+{sandboxActivity.totalAdditions ?? 0}</span>{" "}
                <span className="text-red-400">-{sandboxActivity.totalDeletions ?? 0}</span>
              </span>
              <span className="px-2 py-1 bg-surface-container border border-white/10 rounded text-[10px] font-code-label text-on-surface-variant uppercase">{sandboxActivity.stage}</span>
            </div>
          </div>
          {(sandboxActivity.files ?? []).length === 0 ? (
            <div className="text-sm text-on-surface-variant italic">
              {sandboxActivity.stage === "plan" ? "planning, no file changes expected" : "no file changes yet"}
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto border border-white/10 rounded-lg bg-surface-container-lowest">
              {sandboxActivity.files.map(f => (
                <button
                  key={f.path}
                  onClick={() => onOpenActivityFile(f.path)}
                  className="w-full text-left p-2 text-xs font-mono border-b border-white/5 truncate flex items-center justify-between text-on-surface hover:bg-white/5"
                >
                  <span className="truncate" title={f.path}>{f.status} {f.path}</span>
                  <span className="flex-shrink-0 flex gap-1 ml-2">
                    {f.additions > 0 && <span className="text-green-400">+{f.additions}</span>}
                    {f.deletions > 0 && <span className="text-red-400">-{f.deletions}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
});
