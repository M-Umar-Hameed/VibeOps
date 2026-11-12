import { describe, expect, test, vi } from "vitest";
import { startJob, getJob, listJobs, cancelJob } from "../src/services/jobs.js";

test("lifecycle: queued -> running with progress -> done", async () => {
  const key = `k-${Date.now()}-${Math.random()}`;
  let releaseGate!: () => void;
  const gate = new Promise<void>((r) => { releaseGate = r; });

  const { job, promise } = startJob(
    "test-kind",
    key,
    "Test Job",
    async (ctx) => {
      ctx.progress({ phase: "step", done: 1, total: 3 });
      await gate;
      return { ok: 1 };
    },
    { cancellable: true },
  );

  expect(job.state).toBe("queued");
  expect(job.phase).toBe("queued");

  await vi.waitFor(() => {
    const live = getJob(job.id);
    expect(live).toMatchObject({ state: "running", phase: "step", done: 1, total: 3 });
  });

  const active = listJobs({ active: true });
  expect(active.some((j) => j.id === job.id)).toBe(true);

  releaseGate();
  const res = await promise;
  expect(res).toEqual({ ok: 1 });

  const finished = getJob(job.id);
  expect(finished).toMatchObject({ state: "done", result: { ok: 1 }, error: null });
  expect(finished?.finishedAt).not.toBeNull();

  const activeAfter = listJobs({ active: true });
  expect(activeAfter.some((j) => j.id === job.id)).toBe(false);
});

test("failure: sets failed state and error message", async () => {
  const key = `k-${Date.now()}-${Math.random()}`;
  const { job, promise } = startJob(
    "test-fail",
    key,
    "Fail Job",
    async () => {
      throw new Error("boom");
    },
  );

  await expect(promise).rejects.toThrow("boom");
  const failed = getJob(job.id);
  expect(failed).toMatchObject({ state: "failed", error: "boom" });
});

test("dedupe: reuses running job and starts fresh once finished", async () => {
  const key = `k-${Date.now()}-${Math.random()}`;
  let releaseGate!: () => void;
  const gate = new Promise<void>((r) => { releaseGate = r; });
  const runSpy = vi.fn(async () => {
    await gate;
    return "done";
  });

  const first = startJob("test-dedupe", key, "Dedupe Job", runSpy);
  expect(first.existing).toBe(false);

  const second = startJob("test-dedupe", key, "Dedupe Job", runSpy);
  expect(second.existing).toBe(true);
  expect(second.job.id).toBe(first.job.id);
  await Promise.resolve();
  expect(runSpy).toHaveBeenCalledTimes(1);

  releaseGate();
  await first.promise;
  await second.promise;

  const third = startJob("test-dedupe", key, "Dedupe Job", async () => "second run");
  expect(third.existing).toBe(false);
  expect(third.job.id).not.toBe(first.job.id);
  await third.promise;
});

test("cancel: cancellable job can be cancelled, non-cancellable/finished/unknown return false", async () => {
  const key = `k-${Date.now()}-${Math.random()}`;
  let reachedGate!: () => void;
  const reached = new Promise<void>((r) => { reachedGate = r; });
  let releaseGate!: () => void;
  const gate = new Promise<void>((r) => { releaseGate = r; });

  const { job, promise } = startJob(
    "test-cancel",
    key,
    "Cancel Job",
    async (ctx) => {
      reachedGate();
      await gate;
      if (ctx.cancelled) return { cancelled: true };
      return { ok: 1 };
    },
    { cancellable: true },
  );

  await reached;
  expect(cancelJob("unknown-id")).toBe(false);

  expect(cancelJob(job.id)).toBe(true);
  releaseGate();

  await promise;
  const finalJob = getJob(job.id);
  expect(finalJob?.state).toBe("cancelled");
  expect(cancelJob(job.id)).toBe(false);

  // Non-cancellable job
  const key2 = `k-${Date.now()}-${Math.random()}`;
  const nonCancellable = startJob("test-non-cancel", key2, "Non-cancel", async () => "ok", { cancellable: false });
  expect(cancelJob(nonCancellable.job.id)).toBe(false);
  await nonCancellable.promise;
});

test("filter: listJobs filters by kind, newest first", async () => {
  const kindA = `kind-a-${Date.now()}`;
  const kindB = `kind-b-${Date.now()}`;

  const j1 = startJob(kindA, `k1-${Math.random()}`, "Job 1", async () => 1);
  await j1.promise;
  const j2 = startJob(kindB, `k2-${Math.random()}`, "Job 2", async () => 2);
  await j2.promise;
  const j3 = startJob(kindA, `k3-${Math.random()}`, "Job 3", async () => 3);
  await j3.promise;

  const filtered = listJobs({ kind: kindA });
  expect(filtered.map((j) => j.id)).toEqual([j3.job.id, j1.job.id]);
});
