import { join, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { vibeopsHome } from "../runtime/home.js";
import { setRelayWriteGuard } from "../relay/bootstrap-config.js";
import { parseReason } from "../relay/prompts.js";
import { redactSecrets } from "./redact.js";
import { listComments } from "../services/comments.js";
import { desc, isNull, eq, gte, lte, and, lt, or, getTableColumns } from "drizzle-orm";
import { db } from "../db/client.js";
import { forgeRuns, aiUsageLogs, tickets, type Comment } from "../db/schema.js";
import { computeVerificationStatus, loadAdminIds } from "./verify.js";
import { type Stage, type Status, type Effort, type RunSummary, runs, summarize, activeRuns, OUTPUT_CAP } from "./run-state.js";

export function listRuns(): RunSummary[] {
  return [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(summarize);
}

export function activeStageForTicket(ticketId: string): Stage | undefined {
  return activeRuns().find((r) => r.ticketId === ticketId)?.stage;
}

// Settings account edits write relay.json, which the sentinel restores around a work stage.
export function hasAnyActiveRun(): boolean {
  return activeRuns().length > 0;
}

setRelayWriteGuard(hasAnyActiveRun);

export async function hasActiveRun(ticketId: string): Promise<boolean> {
  if (activeRuns().some((r) => r.ticketId === ticketId)) return true;
  const [row] = await db.select({ id: forgeRuns.id }).from(forgeRuns)
    .where(and(eq(forgeRuns.ticketId, ticketId), isNull(forgeRuns.finishedAt)))
    .limit(1);
  return !!row;
}

// Newest run status for a ticket. In-memory wins when it is at least as recent
// as the latest persisted row (settle() persists fire-and-forget, so the DB can
// lag a just-finished run). Used by the rework route's rejected-run guard.
export async function latestRunStatus(ticketId: string): Promise<Status | null> {
  const mem = [...runs.values()]
    .filter((r) => r.ticketId === ticketId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const [row] = await db.select({ status: forgeRuns.status, startedAt: forgeRuns.startedAt })
    .from(forgeRuns).where(eq(forgeRuns.ticketId, ticketId))
    .orderBy(desc(forgeRuns.startedAt)).limit(1);
  if (mem && (!row || mem.startedAt >= row.startedAt.toISOString())) return mem.status;
  return (row?.status as Status) ?? null;
}

export type RunPolicy = { runId: string; paths: string[]; waived: boolean; startedAt: Date };

// Protected-path violation for the ticket's most recent run: the durable gate
// promote/approve/waive all read. Empty paths => nothing to block.
export async function latestRunPolicy(ticketId: string): Promise<RunPolicy | null> {
  const [row] = await db.select({
    id: forgeRuns.id,
    violations: forgeRuns.protectedViolations,
    waivedAt: forgeRuns.policyWaivedAt,
    startedAt: forgeRuns.startedAt,
  }).from(forgeRuns).where(eq(forgeRuns.ticketId, ticketId)).orderBy(desc(forgeRuns.startedAt)).limit(1);
  if (!row) return null;
  return { runId: row.id, paths: row.violations ?? [], waived: row.waivedAt !== null, startedAt: row.startedAt };
}

export async function markPolicyWaived(runId: string): Promise<void> {
  await db.update(forgeRuns).set({ policyWaivedAt: new Date() }).where(eq(forgeRuns.id, runId));
}

export type StageDurationsMs = Partial<Record<"plan" | "work" | "checks" | "review", number>>;

// Per-stage wall time for a settled run. plan/work/review come from
// ai_usage_logs (one row per track() call, durationMs already captured),
// joined by the run's [startedAt, finishedAt] window with the same ±5s
// clock-skew buffer computeVerificationStatus uses. Checks are not an AI
// call, so their duration comes from the run's own checksDurationMs instead.
async function deriveStageDurations(
  ticketId: string, from: Date, to: Date, checksDurationMs?: number | null,
): Promise<StageDurationsMs> {
  const buffer = 5000;
  const rows = await db.select({ model: aiUsageLogs.model, durationMs: aiUsageLogs.durationMs })
    .from(aiUsageLogs)
    .where(and(
      eq(aiUsageLogs.ticketId, ticketId),
      gte(aiUsageLogs.createdAt, new Date(from.getTime() - buffer)),
      lte(aiUsageLogs.createdAt, new Date(to.getTime() + buffer)),
    ));
  const out: StageDurationsMs = {};
  for (const r of rows) {
    if (!r.durationMs) continue;
    if (r.model !== "plan" && r.model !== "work" && r.model !== "review") continue;
    out[r.model] = (out[r.model] ?? 0) + r.durationMs;
  }
  if (checksDurationMs != null) out.checks = checksDurationMs;
  return out;
}

export type RunListItem = RunSummary & { persisted?: boolean; modelVerified?: boolean | "unknown"; rejectionReason?: string; failureReason?: string; stageDurationsMs?: StageDurationsMs };
export type RunListOpts = { limit?: number; before?: { startedAt: string; id?: string }; status?: Status; projectId?: string; summary?: boolean };

const HISTORY_LIMIT = 20;
const TICKET_HISTORY_LIMIT = 200;
const LIST_CAP = 40;

// Live runs plus recent persisted history, for the UI after a server restart
// (live is authoritative for anything still in memory; DB fills the rest).
export async function listRunsWithHistory(ticketId?: string, opts: RunListOpts = {}): Promise<RunListItem[]> {
  const projectTickets = opts.projectId
    ? new Set((await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.projectId, opts.projectId))).map((r) => r.id))
    : null;
  const live = listRuns().filter((r) => (!ticketId || r.ticketId === ticketId) && (!projectTickets || projectTickets.has(r.ticketId)));
  const liveIds = new Set(live.map((r) => r.id));
  const before = opts.before;
  const beforeAt = before ? new Date(before.startedAt) : undefined;
  const base = db.select(getTableColumns(forgeRuns)).from(forgeRuns).$dynamic();
  const rows = await (opts.projectId ? base.innerJoin(tickets, eq(forgeRuns.ticketId, tickets.id)) : base)
    .where(and(
      ticketId ? eq(forgeRuns.ticketId, ticketId) : undefined,
      opts.status ? eq(forgeRuns.status, opts.status) : undefined,
      opts.projectId ? eq(tickets.projectId, opts.projectId) : undefined,
      beforeAt ? (before!.id
        ? or(lt(forgeRuns.startedAt, beforeAt), and(eq(forgeRuns.startedAt, beforeAt), lt(forgeRuns.id, before!.id)))
        : lt(forgeRuns.startedAt, beforeAt)) : undefined,
    ))
    .orderBy(desc(forgeRuns.startedAt), desc(forgeRuns.id))
    .limit(opts.limit ?? (ticketId ? TICKET_HISTORY_LIMIT : HISTORY_LIMIT));
  const persisted: RunListItem[] = rows
    .filter((r) => !liveIds.has(r.id))
    .map((r) => ({
      id: r.id, ticketId: r.ticketId, status: r.status as Status, stage: r.stage as Stage,
      agents: { plan: r.planAgent, work: r.workAgent, review: r.reviewAgent },
      effort: (r.effort ?? undefined) as Effort | undefined,
      checksDurationMs: r.checksDurationMs ?? undefined,
      cause: r.cause ?? undefined, causeDetail: r.causeDetail ?? undefined,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : undefined,
      persisted: true,
      ...(opts.summary ? { cause: r.cause ?? undefined, causeDetail: r.causeDetail ?? undefined } : {}),
    }));
  const isBefore = (r: RunListItem) => !before
    || r.startedAt < before.startedAt
    || (r.startedAt === before.startedAt && !!before.id && r.id < before.id);
  const list: RunListItem[] = [...live, ...persisted]
    .filter((r) => (!opts.status || r.status === opts.status) && isBefore(r))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
    .slice(0, opts.limit ?? (ticketId ? TICKET_HISTORY_LIMIT : LIST_CAP));
  if (opts.summary) return list;

  const commentsByTicket = new Map<string, Promise<Comment[]>>();
  const commentsFor = (id: string) => {
    let p = commentsByTicket.get(id);
    if (!p) { p = listComments(id); commentsByTicket.set(id, p); }
    return p;
  };
  let admins: Promise<Set<string>> | undefined;

  const enrichPromises = list.map(async (item) => {
    item.modelVerified = await computeVerificationStatus(item.ticketId, {
      from: new Date(item.startedAt),
      to: item.finishedAt ? new Date(item.finishedAt) : null,
    }, { comments: commentsFor(item.ticketId), adminIds: admins ??= loadAdminIds() });
    if (item.status !== "running" && item.finishedAt) {
      item.stageDurationsMs = await deriveStageDurations(
        item.ticketId, new Date(item.startedAt), new Date(item.finishedAt), item.checksDurationMs,
      );
    }
    if (item.status === "rejected" || item.status === "failed" || item.status === "stopped") {
      if (item.cause) {
        const reason = item.causeDetail || item.cause;
        if (item.status === "rejected") item.rejectionReason = reason;
        else item.failureReason = reason;
      } else {
        const comments = await commentsFor(item.ticketId);
        const from = new Date(item.startedAt).getTime();
        const to = item.finishedAt ? new Date(item.finishedAt).getTime() : Date.now();
        const inWindow = (c: { createdAt: Date }) => {
          const at = new Date(c.createdAt).getTime();
          return at >= from && at <= to;
        };
        if (item.status === "rejected") {
          const review = [...comments].reverse().find((c) => c.kind === "review" && inWindow(c));
          if (review) item.rejectionReason = parseReason(review.body.split("\n\n[forge: ")[0]);
        } else {
          // bounce() records why a run died as a "forge: <why>" report comment;
          // its first line is the reason the run card shows.
          const report = [...comments].reverse().find((c) => c.kind === "report" && c.body.startsWith("forge: ") && inWindow(c));
          if (report) item.failureReason = report.body.split(/\r?\n/)[0].slice("forge: ".length).trim();
        }
      }
    }
  });
  await Promise.all(enrichPromises);

  return list;
}

export function getRunOutput(id: string, after: number) {
  const r = runs.get(id);
  if (!r) return undefined;
  const from = Math.max(0, Math.min(after, r.output.length));
  return { chunk: r.output.slice(from), next: r.output.length, stage: r.stage, status: r.status };
}

export async function getSettledRunOutput(id: string, after: number) {
  const [row] = await db.select().from(forgeRuns).where(eq(forgeRuns.id, id)).limit(1);
  if (!row?.logPath) return undefined;
  const path = resolve(row.logPath);
  if (!path.startsWith(resolve(join(vibeopsHome(), ".vibeops", "runs")) + sep)) return undefined;
  let text: string;
  try { text = redactSecrets(await readFile(path, "utf-8")); } catch { return undefined; }
  const from = Math.max(0, Math.min(after, text.length));
  const chunk = text.slice(from, from + OUTPUT_CAP);
  return { chunk, next: from + chunk.length, stage: row.stage, status: row.status, source: "log" as const };
}

// Test/introspection accessor: absolute timestamps for checks and review. checksEndedAt <= reviewStartedAt proves checks finished before review began.
export function getRunTimings(id: string) {
  const r = runs.get(id);
  if (!r) return undefined;
  return { checksStartedAt: r.checksStartedAt, checksEndedAt: r.checksEndedAt, reviewStartedAt: r.reviewStartedAt };
}

// Test-teardown hook: resolve once every in-flight run has fully settled. Deleting a
// workdir while a run is still winding down (later stages, analyzer, git) EPERMs on
// Windows. Production never needs this - stop stays prompt.
export async function settleAll(): Promise<void> {
  await Promise.allSettled([...runs.values()].map((r) => r.done));
}

export function awaitRun(id: string): Promise<void> {
  return runs.get(id)?.done ?? Promise.resolve();
}
