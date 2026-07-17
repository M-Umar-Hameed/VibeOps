import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { resolveCmd, type RelayConfig, type RelayAgent } from "../relay/config.js";
import { composePlanPrompt, composeWorkPrompt, composeReviewPrompt, parseVerdict } from "../relay/prompts.js";
import { runAgent, killTree } from "../relay/invoke.js";
import { redactSecrets } from "./redact.js";
import { ensureSandbox, forgeCommit, sandboxDiff, sandboxDiffSummary } from "./sandbox.js";
import { pickAgents, escalate, pairsForRole, type Pick, type RoutingStrategy } from "./router.js";
import { updateTicket } from "../services/tickets.js";
import { addComment, listComments } from "../services/comments.js";
import { getTicket } from "../services/history.js";
import { searchKnowledge } from "../services/knowledge.js";
import { getSetting } from "../services/settings.js";
import { ConflictError } from "../services/errors.js";
import { logAgentUse, startAgentSession, endAgentSession } from "../services/usage.js";
import { desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { forgeRuns } from "../db/schema.js";

const OUTPUT_CAP = 400_000;
const MAX_ACTIVE = 3;
const KEEP_FINISHED = 20;
const MAX_EXTRA_PROMPT = 10_000;
export const DIFF_PROMPT_CAP = 40_000;

// Large diffs blow the reviewer's context for little benefit; past the cap, a
// stat summary plus a prefix is enough signal to judge the change.
export function reviewDiffPayload(fullDiff: string, stat: string, cap = DIFF_PROMPT_CAP): string {
  if (fullDiff.length <= cap) return fullDiff;
  return `[diff too large: showing stat + first ${cap / 1000}k chars]\n${stat}\n\n${fullDiff.slice(0, cap)}`;
}

const NARRATION =
  "\n\nNarrate your reasoning out loud as you work: before each step, print what " +
  "you are about to do and why. Your narration is read live by the supervisor " +
  "and by the reviewing model.";

// Plan/review agents run in the REAL workdir; a permissive CLI would happily
// write there (live incident: claude acceptEdits implemented during planning).
const PLAN_ONLY =
  "\n\nOutput the plan as text only. Do NOT create, modify, or delete any files; " +
  "implementation happens later in an isolated workspace.";

type Stage = "plan" | "work" | "review";
type Status = "running" | "passed" | "failed" | "stopped";

type Run = {
  id: string; ticketId: string; stage: Stage; status: Status;
  agents: { plan: string; work: string; review: string };
  output: string; startedAt: string; finishedAt?: string;
  child?: ChildProcess; // the in-flight agent CLI for the current stage, if any
  stopped: boolean;
  done: Promise<void>;
};

const runs = new Map<string, Run>();

export type RunSummary = Omit<Run, "output" | "child" | "stopped" | "done">;

function summarize(r: Run): RunSummary {
  const { output, child, stopped, done, ...rest } = r;
  void output; void child; void stopped; void done;
  return rest;
}

function append(run: Run, text: string): void {
  if (run.output.length < OUTPUT_CAP) run.output += redactSecrets(text);
}

function activeRuns(): Run[] {
  return [...runs.values()].filter((r) => r.status === "running");
}

// Wraps a stage's runAgent call with an agent_sessions row (start/end) and an
// ai_usage_logs row (estimated tokens from output length). Never throws.
async function track(
  actorId: string, ticketId: string, role: Stage, agentName: string,
  fn: () => Promise<{ ok: boolean; output: string }>,
): Promise<{ ok: boolean; output: string }> {
  const sessionId = await startAgentSession(`${role}:${agentName}`);
  const startedAt = Date.now();
  const res = await fn();
  await endAgentSession(sessionId, res.ok);
  await logAgentUse({
    actorId, agent: agentName, role, ticketId,
    outputChars: res.output.length, durationMs: Date.now() - startedAt, ok: res.ok,
  });
  return res;
}

function getAgent(config: RelayConfig, name: string, role: Stage): RelayAgent {
  const a = config.agents[name];
  if (!a) throw new Error(`relay config has no agent "${name}"`);
  if (!a.roles.includes(role)) throw new Error(`agent "${name}" is not configured for role "${role}"`);
  return a;
}

// "agent:model" when a model was chosen, plain agent name otherwise -- this
// composite is what's stored in run.agents / forge_runs (no schema change).
function composite(pick: Pick): string {
  return pick.model ? `${pick.agent}:${pick.model}` : pick.agent;
}

async function countFailedReviews(ticketId: string): Promise<number> {
  const comments = await listComments(ticketId);
  return comments.filter((c) => c.kind === "review" && !parseVerdict(c.body).pass).length;
}

export async function startPipeline(
  actorId: string, config: RelayConfig,
  opts: {
    ticketId: string; planAgent: string; workAgent: string; reviewAgent: string; extraPrompt?: string;
    planModel?: string; workModel?: string; reviewModel?: string;
  },
): Promise<{ runId: string }> {
  if ((opts.extraPrompt ?? "").length > MAX_EXTRA_PROMPT) throw new Error("extraPrompt too long");

  const strategyRaw = await getSetting("ai.routing_strategy");
  const strategy: RoutingStrategy =
    strategyRaw === "cheapest-first" || strategyRaw === "quality-first" ? strategyRaw : "balanced";
  let auto: { plan: Pick; work: Pick; review: Pick } | undefined;
  const getAuto = () => (auto ??= pickAgents(config, strategy));

  let planPick: Pick = opts.planAgent === "auto" ? getAuto().plan : { agent: opts.planAgent, model: opts.planModel };
  let workPick: Pick = opts.workAgent === "auto" ? getAuto().work : { agent: opts.workAgent, model: opts.workModel };
  const reviewPick: Pick =
    opts.reviewAgent === "auto" ? getAuto().review : { agent: opts.reviewAgent, model: opts.reviewModel };

  if (opts.workAgent === "auto") {
    const attempts = await countFailedReviews(opts.ticketId);
    workPick = escalate(pairsForRole(config, "work"), workPick, attempts);
  }

  const agents = {
    plan: { ...getAgent(config, planPick.agent, "plan") },
    work: { ...getAgent(config, workPick.agent, "work") },
    review: { ...getAgent(config, reviewPick.agent, "review") },
  };
  agents.plan.cmd = resolveCmd(agents.plan, planPick.model);
  agents.work.cmd = resolveCmd(agents.work, workPick.model);
  agents.review.cmd = resolveCmd(agents.review, reviewPick.model);

  if (activeRuns().some((r) => r.ticketId === opts.ticketId)) {
    throw new ConflictError(`ticket ${opts.ticketId} already has an active run`);
  }
  if (activeRuns().length >= MAX_ACTIVE) throw new ConflictError("too many active runs");

  const ticket = await getTicket(opts.ticketId);
  if (ticket.status !== "open" && ticket.status !== "planned") {
    throw new ConflictError(`ticket is ${ticket.status}; pipeline needs open or planned`);
  }

  const run: Run = {
    id: randomUUID(), ticketId: opts.ticketId, stage: "plan", status: "running",
    agents: { plan: composite(planPick), work: composite(workPick), review: composite(reviewPick) },
    output: "", startedAt: new Date().toISOString(), stopped: false,
    done: Promise.resolve(),
  };
  runs.set(run.id, run);
  trim();
  run.done = pipeline(run, actorId, config, agents, opts.extraPrompt).catch(async (e) => {
    append(run, `\nforge: pipeline error: ${(e as Error).message}\n`);
    // Uphold the never-stuck-in_progress invariant even for unexpected throws
    // (forgeCommit/addComment failures land here, after the claim).
    await bounce(run, actorId, "pipeline error", (e as Error).message);
    settle(run, "failed");
  });
  return { runId: run.id };
}

async function pipeline(
  run: Run, actorId: string, config: RelayConfig,
  agents: { plan: RelayAgent; work: RelayAgent; review: RelayAgent }, extraPrompt?: string,
): Promise<void> {
  const extra = extraPrompt ? `\n\nOperator instructions:\n${extraPrompt}` : "";
  const onData = (c: string) => append(run, c);
  let ticket = await getTicket(run.ticketId);

  // plan
  let plan: string;
  if (ticket.status === "open") {
    append(run, `=== FORGE plan (${run.agents.plan}) ===\n`);
    const knowledge = await getKnowledgeSafe(ticket.title);
    const res = await track(actorId, ticket.id, "plan", run.agents.plan, () => runAgent(
      agents.plan, composePlanPrompt({ ticket, knowledge }) + PLAN_ONLY + extra, config.workdir, onData,
      (child) => { run.child = child; },
    ));
    run.child = undefined;
    if (run.stopped) return settle(run, "stopped");
    if (!res.ok) { await bounce(run, actorId, "planner failed", res.output); return settle(run, "failed"); }
    // Comments are the DURABLE record — redact them too, not just the console.
    await addComment(actorId, ticket.id, redactSecrets(res.output), "plan");
    ticket = await updateTicket(actorId, ticket.id, ticket.version, { status: "planned" });
    plan = res.output;
  } else {
    const prior = [...(await listComments(ticket.id))].reverse().find((c) => c.kind === "plan");
    plan = prior?.body ?? "";
  }

  // work — claim, then run inside the sandbox
  run.stage = "work";
  append(run, `\n=== FORGE work (${run.agents.work}) ===\n`);
  ticket = await updateTicket(actorId, ticket.id, ticket.version, { status: "in_progress" });
  const sandbox = await ensureSandbox(config.workdir, ticket.id);
  const knowledge = await getKnowledgeSafe(ticket.title);
  // Rework passes must see why the last review failed, or the worker repeats
  // the same mistakes (live-hit on the first dogfood ticket).
  const lastReview = [...(await listComments(ticket.id))].reverse().find((c) => c.kind === "review");
  const findings = lastReview ? `\n\nPrevious review findings (address ALL of these):\n${lastReview.body}` : "";
  const workPrompt = composeWorkPrompt({ ticket, plan, knowledge, workdir: sandbox })
    + findings + NARRATION + "\n\nDo NOT run git commit; the supervisor commits for you." + extra;
  const workRes = await track(actorId, ticket.id, "work", run.agents.work, () =>
    runAgent(agents.work, workPrompt, sandbox, onData, (child) => { run.child = child; }));
  run.child = undefined;
  if (run.stopped) { await bounce(run, actorId, "run stopped", ""); return settle(run, "stopped"); }
  if (!workRes.ok) { await bounce(run, actorId, "worker failed", workRes.output); return settle(run, "failed"); }
  await forgeCommit(ticket.id, ticket.title);
  await addComment(actorId, ticket.id, redactSecrets(workRes.output), "report");
  ticket = await updateTicket(actorId, ticket.id, ticket.version, { status: "review" });

  // review — against the sandbox branch diff
  run.stage = "review";
  append(run, `\n=== FORGE review (${run.agents.review}) ===\n`);
  const diff = await sandboxDiff(config.workdir, ticket.id);
  const stat = await sandboxDiffSummary(config.workdir, ticket.id);
  const reviewRes = await track(actorId, ticket.id, "review", run.agents.review, () => runAgent(
    agents.review,
    composeReviewPrompt({ ticket, plan, report: workRes.output, diff: reviewDiffPayload(diff, stat) }),
    config.workdir, onData,
    (child) => { run.child = child; },
  ));
  run.child = undefined;
  if (run.stopped) return settle(run, "stopped");
  const verdict = parseVerdict(reviewRes.output);
  await addComment(actorId, ticket.id, redactSecrets(verdict.raw), "review");
  if (!verdict.pass) {
    // FAIL: back to planned; sandbox kept for the rework pass.
    await updateTicket(actorId, ticket.id, ticket.version, { status: "planned" });
  }
  // PASS: ticket STAYS in review — promotion is a human action.
  settle(run, "passed");
}

function settle(run: Run, status: Status): void {
  run.status = status;
  run.finishedAt = new Date().toISOString();
  void persistRun(run); // fire-and-forget: history must never break a pipeline
}

// Single choke point for run-history rows. Best-effort: comments already hold
// the durable plan/report/review record, this is just for the runs list.
async function persistRun(run: Run): Promise<void> {
  try {
    await db.insert(forgeRuns).values({
      id: run.id,
      ticketId: run.ticketId,
      status: run.status,
      stage: run.stage,
      planAgent: run.agents.plan,
      workAgent: run.agents.work,
      reviewAgent: run.agents.review,
      startedAt: new Date(run.startedAt),
      finishedAt: run.finishedAt ? new Date(run.finishedAt) : undefined,
    });
  } catch (e) {
    console.warn(`forge: failed to persist run ${run.id}:`, (e as Error).message);
  }
}

async function bounce(run: Run, actorId: string, why: string, output: string): Promise<void> {
  try {
    const t = await getTicket(run.ticketId);
    await addComment(actorId, t.id, redactSecrets(`forge: ${why}\n\n${output.slice(0, 20_000)}`), "report");
    if (t.status === "in_progress") await updateTicket(actorId, t.id, t.version, { status: "planned" });
  } catch { /* never mask the original failure */ }
}

async function getKnowledgeSafe(q: string): Promise<{ content: string; citation: string }[]> {
  try { return await searchKnowledge(q, { limit: 5 }); } catch { return []; }
}

function trim(): void {
  const finished = [...runs.values()].filter((r) => r.status !== "running")
    .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
  for (const r of finished.slice(KEEP_FINISHED)) runs.delete(r.id);
}

export function listRuns(): RunSummary[] {
  return [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(summarize);
}

export type RunListItem = RunSummary & { persisted?: boolean };

const HISTORY_LIMIT = 20;
const LIST_CAP = 40;

// Live runs plus recent persisted history, for the UI after a server restart
// (live is authoritative for anything still in memory; DB fills the rest).
export async function listRunsWithHistory(): Promise<RunListItem[]> {
  const live = listRuns();
  const liveIds = new Set(live.map((r) => r.id));
  const rows = await db.select().from(forgeRuns).orderBy(desc(forgeRuns.startedAt)).limit(HISTORY_LIMIT);
  const persisted: RunListItem[] = rows
    .filter((r) => !liveIds.has(r.id))
    .map((r) => ({
      id: r.id, ticketId: r.ticketId, status: r.status as Status, stage: r.stage as Stage,
      agents: { plan: r.planAgent, work: r.workAgent, review: r.reviewAgent },
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : undefined,
      persisted: true,
    }));
  return [...live, ...persisted]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, LIST_CAP);
}

export function getRunOutput(id: string, after: number) {
  const r = runs.get(id);
  if (!r) return undefined;
  const from = Math.max(0, Math.min(after, r.output.length));
  return { chunk: r.output.slice(from), next: r.output.length, stage: r.stage, status: r.status };
}

export function stopRun(id: string): boolean {
  const r = runs.get(id);
  if (!r || r.status !== "running") return false;
  r.stopped = true; // checked between stages so a running stage still lands on "stopped"
  if (r.child) killTree(r.child);
  return true;
}

export function awaitRun(id: string): Promise<void> {
  return runs.get(id)?.done ?? Promise.resolve();
}
