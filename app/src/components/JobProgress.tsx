import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  kind: string;
  key: string;
  label: string;
  trigger: "manual" | "auto";
  state: JobState;
  phase: string;
  done: number | null;
  total: number | null;
  startedAt: string;
  finishedAt: string | null;
  result: any;
  error: string | null;
  cancellable: boolean;
  cancelRequested: boolean;
}

export function isActive(j: Job): boolean {
  return j.state === "queued" || j.state === "running";
}

export function useJobs(path: string): Job[] {
  const { data } = useQuery<Job[]>({
    queryKey: ["jobs", path],
    queryFn: async () => {
      const r = await api.get(path);
      return Array.isArray(r) ? (r as Job[]) : [];
    },
    refetchInterval: (q) => ((q.state.data ?? []) as Job[]).some(isActive) ? 1000 : 5000,
  });
  return data ?? [];
}

export function JobProgress({ job, formatResult }: { job: Job; formatResult?: (r: any) => string }) {
  const qc = useQueryClient();
  const elapsedSec = !isNaN(Date.parse(job.startedAt))
    ? Math.max(0, Math.round((Date.now() - Date.parse(job.startedAt)) / 1000))
    : 0;

  return (
    <div className="space-y-1.5 p-2 rounded bg-surface-container border border-white/5 text-left">
      <div className="flex items-center justify-between gap-2 font-code-label text-[10px] uppercase tracking-widest text-on-surface-variant">
        <span>{job.label}</span>
        {job.phase && <span>{job.phase}</span>}
      </div>

      {typeof job.total === "number" && (
        <div className="space-y-1">
          <progress
            value={job.done ?? 0}
            max={job.total}
            aria-label={`${job.label} progress`}
            className="w-full h-1 accent-primary"
          />
          <div className="font-code-sm text-[10px] text-on-surface-variant/70">
            {`${job.done ?? 0} of ${job.total}`}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <span className="font-code-sm text-[10px] text-on-surface-variant/70">
          {`${elapsedSec}s`}
        </span>
        {isActive(job) && job.cancellable && (
          <button
            type="button"
            aria-label={`Cancel ${job.label}`}
            disabled={job.cancelRequested}
            onClick={async () => {
              await api.post(`/jobs/${job.id}/cancel`);
              qc.invalidateQueries({ queryKey: ["jobs"] });
            }}
            className="text-[10px] px-2 py-0.5 rounded border border-white/10 hover:border-white/20 text-on-surface-variant hover:text-error transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
        )}
      </div>

      {job.state === "failed" && job.error && (
        <div className="text-error text-xs font-code-sm">{job.error}</div>
      )}
      {job.state === "cancelled" && (
        <div className="font-code-label text-[10px] uppercase tracking-widest text-on-surface-variant">
          CANCELLED
        </div>
      )}
      {job.state === "done" && formatResult && job.result && (
        <div className="font-code-sm text-[10px] text-on-surface-variant/70">
          {formatResult(job.result)}
        </div>
      )}
    </div>
  );
}

export function ActiveJobs() {
  const jobs = useJobs("/jobs?active=1");
  if (!jobs.length) return null;

  return (
    <div
      role="region"
      aria-label="Running jobs"
      className="fixed bottom-4 right-4 z-40 w-80 bg-surface-container border border-white/10 rounded-lg p-3 space-y-2 shadow-xl"
    >
      {jobs.map((job) => (
        <JobProgress key={job.id} job={job} />
      ))}
    </div>
  );
}
