import { randomUUID } from "node:crypto";

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";
export type JobProgress = { phase?: string; done?: number | null; total?: number | null };
export interface JobCtx { progress(p: JobProgress): void; readonly cancelled: boolean }
export interface Job {
  id: string; kind: string; key: string; label: string; trigger: "manual" | "auto";
  state: JobState; phase: string; done: number | null; total: number | null;
  startedAt: string; finishedAt: string | null; result: unknown; error: string | null;
  cancellable: boolean; cancelRequested: boolean;
}
export type Started<T> = { job: Job; promise: Promise<T>; existing: boolean };

// ponytail: in-memory registry, lost on restart, keeps last 50 finished jobs.
// Upgrade path: a jobs table if jobs must survive a restart.
const KEEP_FINISHED = 50;
const jobs = new Map<string, Job>();
const running = new Map<string, { job: Job; promise: Promise<unknown> }>();

function prune() {
  const finished = [...jobs.values()].filter((j) => j.finishedAt);
  for (const j of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) jobs.delete(j.id);
}

export function startJob<T>(
  kind: string, key: string, label: string,
  run: (ctx: JobCtx) => Promise<T>,
  opts: { trigger?: "manual" | "auto"; cancellable?: boolean } = {},
): Started<T> {
  const live = running.get(key);
  if (live) return { job: live.job, promise: live.promise as Promise<T>, existing: true };
  const job: Job = {
    id: randomUUID(), kind, key, label, trigger: opts.trigger ?? "manual",
    state: "queued", phase: "queued", done: null, total: null,
    startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null,
    cancellable: opts.cancellable ?? false, cancelRequested: false,
  };
  jobs.set(job.id, job);
  const ctx: JobCtx = {
    progress(p) {
      if (p.phase !== undefined) job.phase = p.phase;
      if (p.done !== undefined) job.done = p.done;
      if (p.total !== undefined) job.total = p.total;
    },
    get cancelled() { return job.cancelRequested; },
  };
  const promise = (async () => {
    await Promise.resolve(); // registered in `running` before run starts
    job.state = "running"; job.phase = "starting";
    try {
      const result = await run(ctx);
      job.result = result;
      job.state = job.cancelRequested ? "cancelled" : "done";
      return result;
    } catch (e) {
      job.error = (e as Error).message; job.state = "failed";
      throw e;
    } finally {
      job.finishedAt = new Date().toISOString();
      running.delete(key);
      prune();
    }
  })();
  promise.catch(() => {}); // async (?async=1) callers never await; avoid unhandledRejection
  running.set(key, { job, promise });
  return { job, promise, existing: false };
}

export function getJob(id: string): Job | null { return jobs.get(id) ?? null; }
export function listJobs(f: { kind?: string; active?: boolean } = {}): Job[] {
  return [...jobs.values()]
    .filter((j) => (!f.kind || j.kind === f.kind) && (!f.active || j.state === "queued" || j.state === "running"))
    .reverse();
}
export function cancelJob(id: string): boolean {
  const j = jobs.get(id);
  if (!j || !j.cancellable || j.finishedAt) return false;
  j.cancelRequested = true;
  return true;
}
