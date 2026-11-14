import { readFileSync, writeFileSync } from "node:fs";
import { harvestLessons } from "./lessons.js";
import { startTimeReader } from "../runtime/proc-start.js";
import { type ChildProcess } from "node:child_process";
import { killTree } from "../relay/invoke.js";
import { redactSecrets } from "./redact.js";
import { updateTicket } from "../services/tickets.js";
import { addComment, listComments } from "../services/comments.js";
import { getTicket } from "../services/history.js";
import { ConflictError, StaleVersionError } from "../services/errors.js";
import { listActors } from "../services/actors.js";
import { db } from "../db/client.js";
import { forgeRuns, type Ticket } from "../db/schema.js";
import { emitEvent } from "../api/events.js";

export const OUTPUT_CAP = 400_000;
const KEEP_FINISHED = 20;

export type Stage = "plan" | "work" | "review";
export const RUN_STATUSES = ["running", "passed", "rejected", "failed", "stopped", "interrupted"] as const;
export type Status = typeof RUN_STATUSES[number];

export type Effort = "quick" | "standard" | "max";

export type Run = {
  id: string; ticketId: string; stage: Stage; status: Status;
  agents: { plan: string; work: string; review: string };
  operatorNotes?: string;
  effort?: Effort;
  protectedViolations?: string[];
  checksDurationMs?: number;
  checksStartedAt?: number;   // epoch ms checks were kicked off (concurrent lane)
  checksEndedAt?: number;     // epoch ms checks actually resolved (true runtime end)
  reviewStartedAt?: number;   // epoch ms the review loop began
  pid?: number;        // OS pid of the current stage's agent child; cleared on settle
  lastLogSize?: number;      // last observed logPath size (stall detection)
  lastActivityAt?: number;  // epoch ms of last log growth or busy CPU; the stall clock resets here
  lastCpuMs?: number;       // last process-tree CPU reading
  stallReason?: string;     // set by the sweep; the pipeline posts it as the report
  logPath: string;     // stable per-run log path (recorded only; reattach ticket writes it)
  runToken: string;    // value of env VIBEOPS_RUN_TOKEN handed to every stage child
  procStartedAt?: string; // child OS start time at spawn; boot compares to prove same process
  accounts?: { plan?: string; work?: string; review?: string }; // subscription account id per stage
  cause?: string; causeDetail?: string;
  workBaseSha?: string; baseBranch?: string;
  stageTimes?: { stage: string; attempt: number; startedAt: string; endedAt?: string }[];
  resumeAt?: string;
  limitWaits?: number;
  promoteOnPass?: boolean;
  allowPaths?: string[]; gateOnlyPaths?: string[]; gateOnlySha?: string;
  limit?: { role: "plan" | "work" | "review"; account: string }; // usage limit hit this run (memory only)
  projectId?: string; title?: string; declared?: string[]; // plan overlap check (memory only)
  output: string; startedAt: string; finishedAt?: string;
  child?: ChildProcess; // the in-flight agent CLI for the current stage, if any
  checksChild?: ChildProcess; // the concurrently-running checks command, if any
  abort?: () => void;   // in-loop sdk lane's AbortController.abort, if any
  stopped: boolean;
  done: Promise<void>;
  persisted?: Promise<void>; // settle()'s history write; run.done awaits it
};

export const runs = new Map<string, Run>();

export type RunSummary = Omit<Run, "output" | "child" | "checksChild" | "abort" | "stopped" | "done" | "persisted" | "pid" | "logPath" | "runToken" | "procStartedAt" | "lastLogSize" | "lastActivityAt" | "lastCpuMs" | "stallReason" | "declared">;

export function summarize(r: Run): RunSummary {
  const { output, child, checksChild, abort, stopped, done, persisted, pid, logPath, runToken, procStartedAt, lastLogSize, lastActivityAt, lastCpuMs, stallReason, declared, ...rest } = r;
  void output; void child; void checksChild; void abort; void stopped; void done; void persisted; void pid; void logPath; void runToken; void procStartedAt; void lastLogSize; void lastActivityAt; void lastCpuMs; void stallReason; void declared;
  return rest;
}

// Status writes land minutes after the ticket was last read (a stage ran in
// between), and any edit meanwhile (spec edit, MCP update, sync) made that
// version stale. The pipeline owns the status during a run, so write against
// the fresh version and retry once, as writeSpecFromPlan does.
export async function setStatus(actorId: string, ticketId: string, status: Ticket["status"]): Promise<Ticket> {
  const write = async () => {
    const fresh = await getTicket(ticketId);
    if (fresh.status === "closed") throw new ConflictError("ticket was closed during the run");
    return updateTicket(actorId, ticketId, fresh.version, { status });
  };
  try {
    return await write();
  } catch (e) {
    if (!(e instanceof StaleVersionError)) throw e;
    return write();
  }
}

export function append(run: Run, text: string): void {
  if (run.output.length < OUTPUT_CAP) run.output += redactSecrets(text);
}

// Single choke point for a stage beginning: set run.stage AND push a run.stage
// SSE frame. Every real transition routes through here.
export function enterStage(run: Run, stage: Stage): void {
  run.stage = stage;
  emitEvent("run.stage", { runId: run.id, ticketId: run.ticketId, stage });
}

// Records the just-spawned stage child and persists its pid so a restart can find
// the live OS process (S2-A1). Fire-and-forget persist, like settle()'s. Also
// honours an already-requested stop, exactly as the inline callbacks it replaces.
export function recordSpawn(run: Run, child: ChildProcess): void {
  run.child = child;
  run.pid = child.pid;
  // Capture the child's OS start time now so a boot reattach can prove THIS exact
  // process (not a recycled pid) is still ours. ponytail: synchronous read at each
  // stage spawn — a file read on Linux, one ps/PowerShell shell-out on macOS/Windows
  // (~150ms, boot-tier infra, 3x per run). Move async if stage-start latency bites.
  run.procStartedAt = child.pid != null ? (startTimeReader.read(child.pid) ?? undefined) : undefined;
  void persistRun(run);
  if (run.stopped) void killTree(child);
}

export function activeRuns(): Run[] {
  return [...runs.values()].filter((r) => r.status === "running");
}

const CAUSE_DETAIL_CAP = 300;

export function setCause(run: Run, cause: string, detail?: string): void {
  if (run.finishedAt) return; // first settle wins; keep its cause
  run.cause = cause;
  run.causeDetail = detail ? redactSecrets(detail).slice(0, CAUSE_DETAIL_CAP) : undefined;
}

export function settle(run: Run, status: Status): void {
  if (run.finishedAt) return; // first settle wins; a later stall/tail settle must never override
  run.status = status;
  run.finishedAt = new Date().toISOString();
  emitEvent("run.settled", { runId: run.id, ticketId: run.ticketId, status });
  run.pid = undefined; // a settled row must never look live (S2-A1)
  // Child wrote the log raw via fd (invoke.ts ponytail); rewrite it redacted once the run settles.
  // ponytail: best-effort, whole-file read; live tail before settle reads the raw file but only via append() (redacted).
  try {
    const raw = readFileSync(run.logPath, "utf-8");
    const clean = redactSecrets(raw);
    if (clean !== raw) writeFileSync(run.logPath, clean);
  } catch { /* absent/unreadable log: nothing to redact */ }
  // Still never allowed to break a pipeline, but the promise is kept so run.done
  // can await it. hasActiveRun consults the DB after the in-memory map goes quiet,
  // so until this row lands a settled run still reads as active. That gap used to
  // be covered by the analyzer's extra await; deleting the analyzer exposed it.
  run.persisted = persistRun(run).catch(() => {});
  void harvestRunLessons(run, status).catch(() => {});
}

async function harvestRunLessons(run: Run, status: Status): Promise<void> {
  if (status !== "rejected" && status !== "failed") return;
  const comments = await listComments(run.ticketId);
  const lastReview = [...comments].reverse().find((c) => c.kind === "review");
  const reviewBody = lastReview?.body ?? "";
  if (!reviewBody.includes("VERDICT: FAIL") && !reviewBody.includes("Critical:")) return;
  const ticket = await getTicket(run.ticketId);
  const actorsList = await listActors();
  const actorId = actorsList[0]?.id;
  if (!actorId) return;
  await harvestLessons(actorId, {
    ticketTitle: ticket.title,
    status,
    reviewFindings: reviewBody,
  });
}

// Single choke point for run-history rows. Best-effort: comments already hold
// the durable plan/report/review record, this is just for the runs list.
export async function persistRun(run: Run): Promise<void> {
  try {
    const finishedAt = run.finishedAt ? new Date(run.finishedAt) : undefined;
    const resumeAt = run.resumeAt ? new Date(run.resumeAt) : null;
    await db.insert(forgeRuns).values({
      id: run.id,
      ticketId: run.ticketId,
      status: run.status,
      stage: run.stage,
      planAgent: run.agents.plan,
      workAgent: run.agents.work,
      reviewAgent: run.agents.review,
      effort: run.effort ?? null,
      protectedViolations: run.protectedViolations ?? null,
      checksDurationMs: run.checksDurationMs ?? null,
      pid: run.pid ?? null,
      logPath: run.logPath,
      runToken: run.runToken,
      procStartedAt: run.procStartedAt ?? null,
      accounts: run.accounts ?? null,
      cause: run.cause ?? null,
      causeDetail: run.causeDetail ?? null,
      workBaseSha: run.workBaseSha ?? null,
      baseBranch: run.baseBranch ?? null,
      stageTimes: run.stageTimes ?? null,
      resumeAt,
      limitWaits: run.limitWaits ?? null,
      promoteOnPass: run.promoteOnPass ?? null,
      allowPaths: run.allowPaths ?? null,
      gateOnlyPaths: run.gateOnlyPaths ?? null,
      gateOnlySha: run.gateOnlySha ?? null,
      startedAt: new Date(run.startedAt),
      finishedAt,
    }).onConflictDoUpdate({
      target: forgeRuns.id,
      set: { status: run.status, stage: run.stage, finishedAt, protectedViolations: run.protectedViolations ?? null, checksDurationMs: run.checksDurationMs ?? null, pid: run.pid ?? null, procStartedAt: run.procStartedAt ?? null, accounts: run.accounts ?? null, cause: run.cause ?? null, causeDetail: run.causeDetail ?? null, workBaseSha: run.workBaseSha ?? null, baseBranch: run.baseBranch ?? null, stageTimes: run.stageTimes ?? null, resumeAt, limitWaits: run.limitWaits ?? null, promoteOnPass: run.promoteOnPass ?? null, allowPaths: run.allowPaths ?? null, gateOnlyPaths: run.gateOnlyPaths ?? null, gateOnlySha: run.gateOnlySha ?? null }
    });
  } catch (e) {
    console.warn(`forge: failed to persist run ${run.id}:`, (e as Error).message);
  }
}

export async function bounce(run: Run, actorId: string, why: string, output: string): Promise<void> {
  try {
    const t = await getTicket(run.ticketId);
    await addComment(actorId, t.id, redactSecrets(`forge: ${why}\n\n${output.slice(0, 20_000)}`), "report");
    if (t.status === "in_progress") await updateTicket(actorId, t.id, t.version, { status: "planned" });
  } catch { /* never mask the original failure */ }
}

export function trim(): void {
  const finished = [...runs.values()].filter((r) => r.status !== "running")
    .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
  for (const r of finished.slice(KEEP_FINISHED)) runs.delete(r.id);
}
