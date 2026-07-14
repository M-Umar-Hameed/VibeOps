import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { RelayConfig, RelayAgent } from "../relay/config.js";
import { composePlanPrompt, composeWorkPrompt, composeReviewPrompt, parseVerdict } from "../relay/prompts.js";
import { runAgent } from "../relay/invoke.js";
import { redactSecrets } from "./redact.js";
import { ensureSandbox, forgeCommit, sandboxDiff } from "./sandbox.js";
import { updateTicket } from "../services/tickets.js";
import { addComment, listComments } from "../services/comments.js";
import { getTicket } from "../services/history.js";
import { searchKnowledge } from "../services/knowledge.js";
import { ConflictError } from "../services/errors.js";

const OUTPUT_CAP = 400_000;
const MAX_ACTIVE = 3;
const KEEP_FINISHED = 20;
const MAX_EXTRA_PROMPT = 10_000;

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
  child?: ChildProcess; // unused v1 (stop kills via flag); reserved
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

function getAgent(config: RelayConfig, name: string, role: Stage): RelayAgent {
  const a = config.agents[name];
  if (!a) throw new Error(`relay config has no agent "${name}"`);
  if (!a.roles.includes(role)) throw new Error(`agent "${name}" is not configured for role "${role}"`);
  return a;
}

export async function startPipeline(
  actorId: string, config: RelayConfig,
  opts: { ticketId: string; planAgent: string; workAgent: string; reviewAgent: string; extraPrompt?: string },
): Promise<{ runId: string }> {
  if ((opts.extraPrompt ?? "").length > MAX_EXTRA_PROMPT) throw new Error("extraPrompt too long");
  const agents = {
    plan: getAgent(config, opts.planAgent, "plan"),
    work: getAgent(config, opts.workAgent, "work"),
    review: getAgent(config, opts.reviewAgent, "review"),
  };
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
    agents: { plan: opts.planAgent, work: opts.workAgent, review: opts.reviewAgent },
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
    run.status = "failed";
    run.finishedAt = new Date().toISOString();
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
    const res = await runAgent(agents.plan, composePlanPrompt({ ticket, knowledge }) + PLAN_ONLY + extra, config.workdir, onData);
    if (run.stopped) return settle(run, "stopped");
    if (!res.ok) { await bounce(run, actorId, "planner failed", res.output); return settle(run, "failed"); }
    await addComment(actorId, ticket.id, res.output, "plan");
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
  const workPrompt = composeWorkPrompt({ ticket, plan, knowledge, workdir: sandbox })
    + NARRATION + "\n\nDo NOT run git commit; the supervisor commits for you." + extra;
  const workRes = await runAgent(agents.work, workPrompt, sandbox, onData);
  if (run.stopped) { await bounce(run, actorId, "run stopped", ""); return settle(run, "stopped"); }
  if (!workRes.ok) { await bounce(run, actorId, "worker failed", workRes.output); return settle(run, "failed"); }
  await forgeCommit(ticket.id, ticket.title);
  await addComment(actorId, ticket.id, workRes.output, "report");
  ticket = await updateTicket(actorId, ticket.id, ticket.version, { status: "review" });

  // review — against the sandbox branch diff
  run.stage = "review";
  append(run, `\n=== FORGE review (${run.agents.review}) ===\n`);
  const diff = await sandboxDiff(config.workdir, ticket.id);
  const reviewRes = await runAgent(
    agents.review,
    composeReviewPrompt({ ticket, plan, report: workRes.output, diff }),
    config.workdir, onData,
  );
  if (run.stopped) return settle(run, "stopped");
  const verdict = parseVerdict(reviewRes.output);
  await addComment(actorId, ticket.id, verdict.raw, "review");
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
}

async function bounce(run: Run, actorId: string, why: string, output: string): Promise<void> {
  try {
    const t = await getTicket(run.ticketId);
    await addComment(actorId, t.id, `forge: ${why}\n\n${output.slice(0, 20_000)}`, "report");
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

export function getRunOutput(id: string, after: number) {
  const r = runs.get(id);
  if (!r) return undefined;
  const from = Math.max(0, Math.min(after, r.output.length));
  return { chunk: r.output.slice(from), next: r.output.length, stage: r.stage, status: r.status };
}

export function stopRun(id: string): boolean {
  const r = runs.get(id);
  if (!r || r.status !== "running") return false;
  r.stopped = true; // checked between stages; the in-flight agent finishes or times out
  return true;
}

export function awaitRun(id: string): Promise<void> {
  return runs.get(id)?.done ?? Promise.resolve();
}
