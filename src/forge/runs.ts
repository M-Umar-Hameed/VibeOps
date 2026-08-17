import { randomUUID } from "node:crypto";
import { getLessons, lessonsClause } from "./lessons.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { vibeopsHome } from "../runtime/home.js";
import type { ChildProcess } from "node:child_process";
import { resolveCmd, loadRelayConfig, type RelayConfig, type RelayAgent } from "../relay/config.js";
import { pipelineStartWarnings, pipelineStartBlockingError } from "../relay/doctor.js";
import { roleStyle } from "../relay/style.js";
import { composePlanPrompt, composeWorkPrompt, composeReviewPrompt, parseVerdict, parseReason, fenceUntrusted } from "../relay/prompts.js";
import { chunkReviewDiff, mergeReviewVerdicts } from "./review-chunks.js";
import { killTree, type AgentResult } from "../relay/invoke.js";
import { runAgent } from "../relay/dispatch.js";
import { redactSecrets } from "./redact.js";
import { ensureSandbox, forgeCommit, sandboxDiff, sandboxDiffSummary, sandboxDiffNames, sandboxRangePatch, sandboxExists, hasCommitsToPromote, snapshotDeps, detectDepsLeak, discardSandbox, listSandboxTicketIds, sandboxSizeBytes, isLiveWorktree, deleteOrphanIfLinkFree, pruneWorktreeRegistrations, listForgeBranches, deleteMergedBranch } from "./sandbox.js";
import { resolveSensitivePaths, snapshotSensitive, detectAndRestore } from "./sentinel.js";
import { resolveProtectedPaths, parseAllowProtected, evaluateProtectedPaths } from "./policy.js";
import { pickAgents, escalate, pairsForRole, type Pick, type RoutingStrategy } from "./router.js";
import { updateTicket } from "../services/tickets.js";
import { addComment, listComments } from "../services/comments.js";
import { getTicket } from "../services/history.js";
import { searchKnowledge, indexRepoDocs, repoIndexed } from "../services/knowledge.js";
import { getSetting } from "../services/settings.js";
import { projectWorkdir } from "../services/projects.js";
import { ConflictError, StaleVersionError } from "../services/errors.js";
import { logAgentUse, startAgentSession, endAgentSession } from "../services/usage.js";
import { listActors } from "../services/actors.js";
import { bump } from "../services/metrics.js";
import { desc, isNull, sum, eq, gte, lte, and, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { forgeRuns, aiUsageLogs, tickets, type Ticket } from "../db/schema.js";
import { verifyModel, MISMATCH_WARNING, computeVerificationStatus } from "./verify.js";
import { resolveChecks, runChecks, formatChecks, type CheckResult } from "./checks.js";
import { runGate, resolveMutationCmd } from "./gate.js";
import { emitEvent } from "../api/events.js";

const OUTPUT_CAP = 400_000;
const KEEP_FINISHED = 20;

// forge.maxActiveRuns: positive-integer cap on concurrent runs. Malformed or
// unset falls back to the default so a bad setting can never break run start.
const DEFAULT_MAX_ACTIVE = 3;
export function resolveMaxActive(setting: string | null): number {
  const n = parseInt(setting ?? "", 10);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_ACTIVE;
}
const MAX_EXTRA_PROMPT = 10_000;
const MAX_OPERATOR_NOTES = 2000;
// Was 2000 and shared across all requests, which was smaller than a single
// detailed request -- one review round could exhaust it on its own.
const CHANGE_REQUEST_BUDGET = 12_000;
export const DIFF_PROMPT_CAP = 40_000;

// Large diffs blow the reviewer's context for little benefit; past the cap, a
// stat summary plus a prefix is enough signal to judge the change.
// Generated drizzle snapshots run to 1400+ lines and have repeatedly consumed
// the whole diff budget, truncating the actual source changes out of the
// reviewer's sight. Replace their bodies with a one-line placeholder before
// capping so hand-written code always fits first.
export function elideGeneratedDiffs(fullDiff: string): string {
  return fullDiff.replace(
    /^diff --git a\/(drizzle\/meta\/[^\s]+) b\/[^\n]+\n(?:(?!^diff --git ).*\n?)*/gm,
    (_m, path) => `[generated file elided from review diff: ${path}]\n`,
  );
}

export function reviewDiffPayload(fullDiff: string, stat: string, cap = DIFF_PROMPT_CAP): string {
  const diff = elideGeneratedDiffs(fullDiff);
  if (diff.length <= cap) return diff;
  return `[diff too large: showing stat + first ${cap / 1000}k chars]\n${stat}\n\n${diff.slice(0, cap)}`;
}

const NARRATION =
  "\n\nNarrate your reasoning out loud as you work: before each step, print what " +
  "you are about to do and why. Your narration is read live by the supervisor " +
  "and by the reviewing model." +
  // Absolute paths make sandboxed workers write at the REAL repo, which their
  // own workspace security then denies (live incident: agy asked for write
  // approval on D:\...\src, wrote nothing, and reported success anyway).
  "\n\nAll file paths are relative to your current working directory. Never use " +
  "absolute paths and never write outside your working directory, even if the " +
  "plan shows absolute paths.";

// Plan/review agents run in the REAL workdir; a permissive CLI would happily
// write there (live incident: claude acceptEdits implemented during planning).
const PLAN_ONLY =
  "\n\nOutput the plan as text only. Do NOT create, modify, or delete any files; " +
  "implementation happens later in an isolated workspace. Refer to every file " +
  "with repository-relative paths only (src/..., tests/...), never absolute paths.";

type Stage = "plan" | "work" | "review";
type Status = "running" | "passed" | "rejected" | "failed" | "stopped" | "interrupted";

export type Effort = "quick" | "standard" | "max";

type Run = {
  id: string; ticketId: string; stage: Stage; status: Status;
  agents: { plan: string; work: string; review: string };
  operatorNotes?: string;
  effort?: Effort;
  protectedViolations?: string[];
  checksDurationMs?: number;
  pid?: number;        // OS pid of the current stage's agent child; cleared on settle
  logPath: string;     // stable per-run log path (recorded only; reattach ticket writes it)
  runToken: string;    // value of env VIBEOPS_RUN_TOKEN handed to every stage child
  output: string; startedAt: string; finishedAt?: string;
  child?: ChildProcess; // the in-flight agent CLI for the current stage, if any
  checksChild?: ChildProcess; // the concurrently-running checks command, if any
  abort?: () => void;   // in-loop sdk lane's AbortController.abort, if any
  stopped: boolean;
  done: Promise<void>;
  persisted?: Promise<void>; // settle()'s history write; run.done awaits it
};

const runs = new Map<string, Run>();

export type RunSummary = Omit<Run, "output" | "child" | "checksChild" | "abort" | "stopped" | "done" | "persisted" | "pid" | "logPath" | "runToken">;

function summarize(r: Run): RunSummary {
  const { output, child, checksChild, abort, stopped, done, pid, logPath, runToken, ...rest } = r;
  void output; void child; void checksChild; void abort; void stopped; void done; void pid; void logPath; void runToken;
  return rest;
}

// Populate the ticket spec from the plan when the body is empty. A human-written
// spec is authoritative and must survive every run, so re-check emptiness against
// the FRESH row before writing. Mirrors the optimistic-retry in lessons.ts.
async function writeSpecFromPlan(actorId: string, ticketId: string, body: string): Promise<Ticket> {
  const write = async () => {
    const fresh = await getTicket(ticketId);
    if (fresh.body && fresh.body.trim()) return fresh; // human spec wins — no overwrite
    return updateTicket(actorId, ticketId, fresh.version, { body });
  };
  try {
    return await write();
  } catch (e) {
    if (!(e instanceof StaleVersionError)) throw e;
    return write(); // retry once against a fresh version
  }
}

function append(run: Run, text: string): void {
  if (run.output.length < OUTPUT_CAP) run.output += redactSecrets(text);
}

// Single choke point for a stage beginning: set run.stage AND push a run.stage
// SSE frame. Every real transition routes through here.
function enterStage(run: Run, stage: Stage): void {
  run.stage = stage;
  emitEvent("run.stage", { runId: run.id, ticketId: run.ticketId, stage });
}

// Records the just-spawned stage child and persists its pid so a restart can find
// the live OS process (S2-A1). Fire-and-forget persist, like settle()'s. Also
// honours an already-requested stop, exactly as the inline callbacks it replaces.
function recordSpawn(run: Run, child: ChildProcess): void {
  run.child = child;
  run.pid = child.pid;
  void persistRun(run);
  if (run.stopped) void killTree(child);
}

function activeRuns(): Run[] {
  return [...runs.values()].filter((r) => r.status === "running");
}

// Wraps a stage's runAgent call with an agent_sessions row (start/end) and an
// ai_usage_logs row. Lanes that report real usage supply it; the rest fall back to
// an estimate over prompt+output, so promptChars has to reach logAgentUse.
// Never throws.
async function track(
  actorId: string, ticketId: string, role: Stage, agentName: string,
  promptChars: number,
  fn: () => Promise<AgentResult>,
): Promise<AgentResult> {
  const sessionId = await startAgentSession(`${role}:${agentName}`);
  const startedAt = Date.now();
  const res = await fn();
  await endAgentSession(sessionId, res.ok);
  await logAgentUse({
    actorId, agent: agentName, role, ticketId,
    promptChars, outputChars: res.output.length, durationMs: Date.now() - startedAt, ok: res.ok,
    tokens: res.usage?.tokens, cost: res.usage?.cost,
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

// Inverse of composite(): the model half, or undefined for a bare agent name.
// Only the sdk lane needs this; cli agents get the model via resolveCmd.
function modelOf(composited: string): string | undefined {
  return composited.split(":")[1];
}

// "agent:model" (or bare "agent") from a forge.defaultModel.<role> setting.
// ponytail: split on the first ":" — agent/model names carry no colons today.
function parsePair(value: string): Pick {
  const i = value.indexOf(":");
  return i === -1 ? { agent: value } : { agent: value.slice(0, i), model: value.slice(i + 1) || undefined };
}

function applyVerification(res: { ok: boolean; output: string }, compositeName: string, run: Run, config: RelayConfig): void {
  const [agentName, requestedModel] = compositeName.split(":");
  // Match on the actual BINARY, not the relay.json key — users key agents
  // freely ("fable", "agy-gemini"), the CLI's output format follows the exe.
  // sdk agents legitimately carry no cmd (config validation skips it for them),
  // and an empty array would slip past ?? and crash on cmd[0]. Length-check it.
  const configured = config.agents[agentName]?.cmd;
  const cmd = configured?.length ? configured : [agentName];
  const strip = (p0: string) => (p0.replace(/\\/g, "/").split("/").pop() ?? p0).replace(/\.(exe|cmd|bat|mjs|cjs|js|py)$/i, "");
  // Generic interpreters carry no identity — the script they run does.
  const INTERPRETERS = new Set(["node", "python", "python3", "deno", "bun"]);
  const first = strip(cmd[0]);
  const binary = INTERPRETERS.has(first.toLowerCase()) && cmd[1] ? strip(cmd[1]) : first;
  const status = verifyModel(binary, requestedModel, res.output);
  if (status !== "unknown") {
    const marker = `\n\n[forge: verification=${status}]`;
    res.output += marker;
    append(run, marker);
    if (status === "mismatch") {
      res.output += `\n${MISMATCH_WARNING}`;
      append(run, `\n${MISMATCH_WARNING}`);
    }
  }
}

async function countFailedReviews(ticketId: string): Promise<number> {
  const comments = await listComments(ticketId);
  return comments.filter((c) => c.kind === "review" && !parseVerdict(c.body).pass).length;
}

// Ticket's project repo if set and still on disk, else config.workdir (Inbox and
// legacy projects keep working unchanged). Guard: a set-but-non-git repo is a 409,
// not a silent fallback -- forge sandboxes require git.
export async function resolveWorkdir(ticketProjectId: string, config: RelayConfig): Promise<string> {
  const repo = await projectWorkdir(ticketProjectId);
  if (repo === null) return config.workdir;
  if (!existsSync(join(repo, ".git"))) {
    throw new ConflictError("workspace is not a git repository; initialize git first");
  }
  return repo;
}

export type SandboxCleanupResult = { discarded: string[]; reclaimedBytes: number; orphans: string[]; deletedOrphans: string[]; prunedRegistrations: number; deletedBranches: string[]; keptBranches: string[] };

// Manual backlog sweep: discard every on-disk sandbox whose ticket is CLOSED and
// whose forge branch has no commits beyond the project workdir HEAD (already merged
// / pure dead weight). Skips active-run tickets, non-closed tickets, orphan sandboxes
// with no ticket, and any branch still carrying unmerged commits. Removal goes through
// discardSandbox so the deps-unlink-before-delete SAFETY ordering is preserved.
export async function cleanupMergedSandboxes(config: RelayConfig): Promise<SandboxCleanupResult> {
  const discarded: string[] = [];
  const orphans: string[] = [];
  const deletedOrphans: string[] = [];
  const workdirs = new Set<string>([config.workdir]);
  let reclaimedBytes = 0;
  for (const ticketId of listSandboxTicketIds()) {
    if (await hasActiveRun(ticketId)) continue;
    // A directory git has no record of -- an empty dir from an interrupted run, or
    // a partial tree left by a failed worktree removal (missing .git) -- is
    // reclaimable disk but must NOT have worktree commands run against it: that git
    // failure is what aborted the sweep mid-run. Report it as an orphan and carry on.
    if (!isLiveWorktree(ticketId)) {
      // Reclaim it ourselves when the ticket is closed or gone AND no reparse point
      // survives anywhere inside; a surviving link means a recursive delete could
      // traverse into the base repo, so leave + report those.
      let closedOrGone = true;
      try { closedOrGone = (await getTicket(ticketId)).status === "closed"; } catch { /* ticket row gone */ }
      if (closedOrGone) {
        const bytes = deleteOrphanIfLinkFree(ticketId);
        if (bytes !== null) { deletedOrphans.push(ticketId); reclaimedBytes += bytes; continue; }
      }
      orphans.push(ticketId);
      continue;
    }
    let ticket;
    try { ticket = await getTicket(ticketId); } catch { orphans.push(ticketId); continue; } // live worktree, ticket row lost
    if (ticket.status !== "closed") continue;
    const workdir = await resolveWorkdir(ticket.projectId, config);
    workdirs.add(workdir);
    if (await hasCommitsToPromote(workdir, ticketId)) continue; // unmerged work -> keep
    const bytes = sandboxSizeBytes(ticketId);
    await discardSandbox(workdir, ticketId);
    discarded.push(ticketId);
    reclaimedBytes += bytes;
  }
  // Git-side residue that outlives the on-disk sandbox dirs: prunable worktree
  // registrations (a sandbox dir deleted behind git's back) and merged forge/*
  // branches of CLOSED tickets (promote leaves the branch every time). The loop
  // above only visits tickets whose sandbox dir still exists, so neither is
  // reclaimed there once the dir is gone. Delete branches ONLY via the merged-safe
  // -d path; an unmerged branch (-d refuses) is left and reported, exactly as an
  // unmerged sandbox is kept above. Prune before delete: a dangling registration
  // keeps its branch checked out (so -d fails) until pruned.
  // ponytail: sweeps config.workdir plus every workdir a live sandbox resolved to.
  // A non-default project workdir whose sandboxes are ALL already gone is not
  // visited -- its stray branches wait for the next sweep with a live sandbox
  // there. Upgrade path: enumerate project workdirs if that case is ever hit.
  let prunedRegistrations = 0;
  const deletedBranches: string[] = [];
  const keptBranches: string[] = [];
  for (const wd of workdirs) {
    prunedRegistrations += await pruneWorktreeRegistrations(wd);
    for (const branch of await listForgeBranches(wd)) {
      const ticketId = branch.slice("forge/".length);
      let status: string;
      try { status = (await getTicket(ticketId)).status; } catch { continue; } // no ticket row -> out of scope
      if (status !== "closed") continue; // open/review/etc -> out of scope
      if (await hasActiveRun(ticketId)) continue; // active run owns the branch
      if (await deleteMergedBranch(wd, branch)) deletedBranches.push(branch);
      else keptBranches.push(branch); // -d refused: unmerged or checked out -> keep + report
    }
  }
  return { discarded, reclaimedBytes, orphans, deletedOrphans, prunedRegistrations, deletedBranches, keptBranches };
}

export async function startPipeline(
  actorId: string, config: RelayConfig,
  opts: {
    ticketId: string; planAgent: string; workAgent: string; reviewAgent: string; extraPrompt?: string; operatorNotes?: string;
    planModel?: string; workModel?: string; reviewModel?: string; force?: boolean; effort?: Effort;
    resumeStage?: Stage;
  },
): Promise<{ runId: string; doctorWarnings: string[] }> {
  if ((opts.extraPrompt ?? "").length > MAX_EXTRA_PROMPT) throw new Error("extraPrompt too long");

  if (!opts.force) {
    const budget = await checkBudget(opts.ticketId);
    if (!budget.ok) throw new ConflictError(budget.reason);
  }

  const strategyRaw = await getSetting("ai.routing_strategy");
  // The settings UI stores cost/max; the router speaks cheapest-first/
  // quality-first. Accept both vocabularies (the control was silently a
  // no-op before this mapping).
  const strategy: RoutingStrategy =
    strategyRaw === "cheapest-first" || strategyRaw === "cost" ? "cheapest-first"
    : strategyRaw === "quality-first" || strategyRaw === "max" ? "quality-first"
    : "balanced";
  const styleSetting = await getSetting("agents.commProfile");
  const lessons = lessonsClause(await getLessons());
  let auto: { plan: Pick; work: Pick; review: Pick } | undefined;

  // Per-run effort preset overrides the global strategy for auto-resolved
  // roles only; explicit agent/model picks below never consult it.
  const effortStrategy: RoutingStrategy | undefined =
    opts.effort === "quick" ? "cheapest-first"
    : opts.effort === "max" ? "quality-first"
    : undefined;

  const getAuto = () => (auto ??= pickAgents(config, effortStrategy ?? strategy));

  // Saved per-role default. For an "auto" role the priority is: explicit request
  // pick > effort preset (quick/max) > this default > routing strategy. An
  // explicitly chosen effort must beat the default, so defaults apply only when
  // no non-standard effort was requested.
  const defaults: Record<"plan" | "work" | "review", string> = {
    plan: (await getSetting("forge.defaultModel.plan")) ?? "",
    work: (await getSetting("forge.defaultModel.work")) ?? "",
    review: (await getSetting("forge.defaultModel.review")) ?? "",
  };
  const resolveRole = (role: "plan" | "work" | "review", agent: string, model?: string): Pick => {
    if (agent !== "auto") return { agent, model };
    if (!effortStrategy && defaults[role]) return parsePair(defaults[role]);
    return getAuto()[role];
  };

  let planPick: Pick = resolveRole("plan", opts.planAgent, opts.planModel);
  let workPick: Pick = resolveRole("work", opts.workAgent, opts.workModel);
  const reviewPick: Pick = resolveRole("review", opts.reviewAgent, opts.reviewModel);

  if (opts.workAgent === "auto") {
    const attempts = await countFailedReviews(opts.ticketId);
    workPick = escalate(pairsForRole(config, "work"), workPick, attempts);
  }

  // Cache-only doctor check: a spawn-level failure (binary renamed/missing)
  // fails fast here instead of stalling silently mid-pipeline; a soft failure
  // (binary ran, exited non-zero -- e.g. auth expired) is only a warning.
  const chosenAgentNames = [planPick.agent, workPick.agent, reviewPick.agent];
  const blocking = pipelineStartBlockingError(config, chosenAgentNames);
  if (blocking) throw new Error(blocking);
  const doctorWarnings = pipelineStartWarnings(config, chosenAgentNames);

  const agents = {
    plan: { ...getAgent(config, planPick.agent, "plan") },
    work: { ...getAgent(config, workPick.agent, "work") },
    review: { ...getAgent(config, reviewPick.agent, "review") },
  };
  const resolveIfCli = (a: RelayAgent, m?: string) => a.type === "sdk" ? (a.cmd ?? []) : resolveCmd(a, m);
  agents.plan.cmd = resolveIfCli(agents.plan, planPick.model);
  agents.work.cmd = resolveIfCli(agents.work, workPick.model);
  agents.review.cmd = resolveIfCli(agents.review, reviewPick.model);

  if (activeRuns().some((r) => r.ticketId === opts.ticketId)) {
    throw new ConflictError(`ticket ${opts.ticketId} already has an active run`);
  }
  const cap = resolveMaxActive(await getSetting("forge.maxActiveRuns"));
  const active = activeRuns();
  if (active.length >= cap) {
    const occupying = active.map((r) => `${r.ticketId} (${r.stage})`).join(", ");
    throw new ConflictError(
      `concurrency cap reached: ${active.length}/${cap} runs active. In flight: ${occupying}. ` +
      `Stop a run or wait for one to finish before starting another.`,
    );
  }

  const ticket = await getTicket(opts.ticketId);
  const allowed = opts.resumeStage === "review"
    ? ["review"]
    : opts.resumeStage === "work"
      ? ["open", "planned", "in_progress"]
      : ["open", "planned"];
  if (!allowed.includes(ticket.status)) {
    throw new ConflictError(`ticket is ${ticket.status}; pipeline needs ${allowed.join(" or ")}`);
  }
  const workdir = await resolveWorkdir(ticket.projectId, config);

  if (await projectWorkdir(ticket.projectId)) {
    if (!(await repoIndexed(ticket.projectId))) {
      indexRepoDocs(ticket.projectId)
        .catch((e) => console.warn(`repo index failed: ${(e as Error).message}`)); // non-blocking
    }
  }


  const id = randomUUID();
  const runToken = randomUUID();
  // Stable per-run log path under ~/.vibeops/runs — NOT the sandbox (per-ticket and
  // discarded, and absent during the plan stage). ponytail: only recorded here, not
  // created or written; the reattach ticket tees child output to it.
  const logPath = join(vibeopsHome(), ".vibeops", "runs", `${id}.log`);
  // Same token to every stage child via env. New object per agent — these agents are
  // shallow spreads of shared config, so never mutate the nested env in place (leaks
  // across runs). sdk-lane agents ignore agent.env and have no OS child: no token, no
  // pid (documented S2-A1 scope).
  agents.plan.env = { ...agents.plan.env, VIBEOPS_RUN_TOKEN: runToken };
  agents.work.env = { ...agents.work.env, VIBEOPS_RUN_TOKEN: runToken };
  agents.review.env = { ...agents.review.env, VIBEOPS_RUN_TOKEN: runToken };

  const run: Run = {
    id, ticketId: opts.ticketId, stage: "plan", status: "running",
    agents: { plan: composite(planPick), work: composite(workPick), review: composite(reviewPick) },
    operatorNotes: opts.operatorNotes?.slice(0, MAX_OPERATOR_NOTES),
    effort: opts.effort,
    logPath, runToken,
    output: "", startedAt: new Date().toISOString(), stopped: false,
    done: Promise.resolve(),
  };
  runs.set(run.id, run);
  trim();
  await persistRun(run);
  run.done = pipeline(run, actorId, agents, workdir, styleSetting ?? "", lessons, config, opts.extraPrompt, opts.resumeStage).catch(async (e) => {
    append(run, `\nforge: pipeline error: ${(e as Error).message}\n`);
    // Uphold the never-stuck-in_progress invariant even for unexpected throws
    // (forgeCommit/addComment failures land here, after the claim).
    await bounce(run, actorId, "pipeline error", (e as Error).message);
    settle(run, "failed");
  }).then(() => run.persisted).catch(() => {});
  return { runId: run.id, doctorWarnings };
}

async function pipeline(
  run: Run, actorId: string,
  agents: { plan: RelayAgent; work: RelayAgent; review: RelayAgent }, workdir: string, styleSetting: string,
  lessons: string, config: RelayConfig, extraPrompt?: string, resumeStage?: Stage,
): Promise<void> {
  let extra = extraPrompt ? `\n\nOperator instructions:\n${extraPrompt}` : "";
  const onData = (c: string) => append(run, c);
  let ticket = await getTicket(run.ticketId);

  // Resume straight to review: skip plan+work, read existing comments for plan/report
  if (resumeStage === "review") {
    run.stage = "review";
    const comments = await listComments(ticket.id);
    const plan = [...comments].reverse().find((c) => c.kind === "plan")?.body ?? "";
    const report = [...comments].reverse().find((c) => c.kind === "report")?.body ?? "";
    // ponytail: resume-to-review reuses the stale plan without passing
    // change-request comments as amendments (see reviewStage caller below).
    // Upgrade path: thread amendments here too if resume-to-review reworks
    // that add scope start recurring.
    const sandbox = await ensureSandbox(workdir, ticket.id);
    append(run, `\n=== FORGE resume: straight to review (existing sandbox) ===\n`);
    return reviewStage(run, actorId, agents.review, workdir, sandbox, ticket, plan, report, styleSetting, config);
  }

  const allComments = await listComments(ticket.id);
  const planCommentIndex = allComments.map(c => c.kind).lastIndexOf("plan");
  const recentComments = planCommentIndex === -1 ? allComments : allComments.slice(planCommentIndex + 1);
  // Include ALL human comments (kind "comment") written since the last plan;
  // agent-authored kinds (plan/report/review/verification/diff-summary) are not
  // guidance. The CHANGE REQUEST: marker is gone: unmarked guidance used to be
  // dropped silently (a "Supervisor addendum" never reached the worker).
  // Newest first, whole comments only: an earlier comment filling the budget
  // must not silently drop the LATEST feedback. Omissions are announced in the
  // prompt AND in the run output so a dropped comment is observable.
  const humanComments = recentComments.filter(c => c.kind === "comment");
  const kept: string[] = [];
  let budget = CHANGE_REQUEST_BUDGET;
  for (const c of [...humanComments].reverse()) {
    if (c.body.length > budget) break;
    kept.push(c.body);
    budget -= c.body.length + 2;
  }
  const dropped = humanComments.length - kept.length;
  if (humanComments.length) {
    append(run, `=== FORGE comments since last plan: ${humanComments.length} considered, ${kept.length} included${dropped ? `, ${dropped} omitted for length` : ""} ===\n`);
  }
  const commentsText = kept.join("\n\n")
    + (dropped ? `\n\n[${dropped} older comment(s) omitted for length -- the newest are above]` : "");
  if (kept.length) {
    extra += `\n\nComments since last plan:\n${fenceUntrusted("ticket-comments", redactSecrets(commentsText))}`;
  }

  // plan
  let plan: string;
  const planRegenerated = ticket.status === "open";
  if (planRegenerated) {
    enterStage(run, "plan");
    append(run, `=== FORGE plan (${run.agents.plan}) ===\n`);
    const knowledge = await getKnowledgeSafe(ticket.title, ticket.projectId);
    const planPrompt = composePlanPrompt({ ticket, knowledge }) + PLAN_ONLY + lessons + roleStyle("plan", styleSetting) + extra;
    const res = await track(actorId, ticket.id, "plan", run.agents.plan, planPrompt.length, () => runAgent(
      agents.plan, planPrompt, workdir, onData,
      (child) => recordSpawn(run, child),
    ));
    run.child = undefined;
    if (run.stopped) return settle(run, "stopped");
    applyVerification(res, run.agents.plan, run, config);
    if (!res.ok) { await bounce(run, actorId, "planner failed", res.output); return settle(run, "failed"); }
    // Comments are the DURABLE record — redact them too, not just the console.
    await addComment(actorId, ticket.id, redactSecrets(res.output), "plan");
    ticket = await updateTicket(actorId, ticket.id, ticket.version, { status: "planned" });
    plan = res.output;
    // Title-only work orders leave the Spec panel blank; seed it from the plan.
    // Best-effort: a spec-write failure must NOT fail the run.
    if (!ticket.body || !ticket.body.trim()) {
      try {
        const before = ticket.version;
        ticket = await writeSpecFromPlan(actorId, ticket.id, redactSecrets(res.output));
        if (ticket.version !== before) append(run, `\n=== FORGE spec populated from plan ===\n`);
      } catch (e) {
        console.warn(`forge: spec write failed for ${ticket.id}:`, e);
      }
    }
  } else {
    const prior = [...(await listComments(ticket.id))].reverse().find((c) => c.kind === "plan");
    plan = prior?.body ?? "";
  }

  // work — claim, then run inside the sandbox
  enterStage(run, "work");
  append(run, `\n=== FORGE work (${run.agents.work}) ===\n`);
  ticket = await updateTicket(actorId, ticket.id, ticket.version, { status: "in_progress" });
  const frontendDeps = (await getSetting("forge.frontendDeps")) === "true";
  const sandbox = await ensureSandbox(workdir, ticket.id, frontendDeps);
  const knowledge = await getKnowledgeSafe(ticket.title, ticket.projectId);
  // Rework passes must see why the last review failed, or the worker repeats
  // the same mistakes (live-hit on the first dogfood ticket).
  const lastReview = [...(await listComments(ticket.id))].reverse().find((c) => c.kind === "review");
  const findings = lastReview ? `\n\nPrevious review findings (address ALL of these):\n${fenceUntrusted("prior-review-findings", lastReview.body)}` : "";
  const workPrompt = composeWorkPrompt({ ticket, plan, knowledge, workdir: sandbox })
    // No lessons clause here: A/B'd 2026-08-12 (docs/findings/2026-08-12-lessons-clause-ab.md).
    // On work prompts the doc measured inert - identical output on a control task, same
    // defect rate on a task its own "test isolation" line targets. Most of its lines
    // address the supervisor ("Supervisor sweeps before planning", "REPORT:/VERDICT:"),
    // which a worker cannot act on. Still injected at the plan stage, which was not tested.
    + findings + NARRATION + "\n\nDo NOT run git commit; the supervisor commits for you." + roleStyle("work", styleSetting) + extra;
  // Sandbox-escape sentinel: snapshot known-sensitive files OUTSIDE the sandbox
  // before the work stage runs. Bash in a work lane is not OS-jailed, so a diff
  // gate (which only sees the worktree) cannot catch a write to the installed
  // app or another repo. Detect+restore after work converts a silent compromise
  // into a reverted, visible, run-failing one. See docs/AGENT_CLIS.md.
  const depsBaseline = snapshotDeps(workdir);
  const sentinelSnaps = snapshotSensitive(resolveSensitivePaths(await getSetting("forge.sensitivePaths")));
  const workRes = await track(actorId, ticket.id, "work", run.agents.work, workPrompt.length, () =>
    runAgent(agents.work, workPrompt, sandbox, onData,
      (child) => recordSpawn(run, child), (abort) => { run.abort = abort; },
      modelOf(run.agents.work)));
  run.child = undefined;
  run.abort = undefined;
  const tampered = detectAndRestore(sentinelSnaps);
  if (tampered.length) {
    const report =
      `\n[forge: SANDBOX-ESCAPE — the work stage wrote outside its sandbox to protected ` +
      `path(s); each has been restored to its pre-run bytes and the run is failed]\n` +
      tampered.map((p) => `  - ${p}`).join("\n") + "\n";
    append(run, report);
    // Same preservation as the stop/worker-failure paths: a sentinel fires on a
    // run that did real work, so WIP-commit whatever is in the sandbox before
    // settling — a later discard must not silently destroy it. forgeCommit
    // no-ops on a clean tree.
    const saved = await forgeCommit(ticket.id, `WIP (sandbox escape) ${ticket.title}`);
    const note = saved
      ? "\n\n[forge: uncommitted work was saved to the sandbox branch as a WIP commit; promote or discard after review]"
      : "";
    await bounce(run, actorId, "sandbox escape: protected path written outside the worktree", report + note);
    return settle(run, "failed");
  }
  const depsLeak = detectDepsLeak(depsBaseline);
  if (depsLeak.length) {
    let report =
      `\n[forge: DEPS-LEAK — the work stage wrote through the shared node_modules ` +
      `link into the base repo; additions reverted, run failed]\n` +
      depsLeak.map((p) => `  - ${p}`).join("\n") + "\n";
    if (!frontendDeps && depsLeak.some(p => p.includes("app/node_modules") || p.includes("app\\node_modules"))) {
      report += `Hint: a frontend build needs forge.frontendDeps set to true. This costs a per-sandbox copy of app/node_modules.\n`;
    }
    append(run, report);
    // See the sandbox-escape path above: WIP-commit sandbox work before settling
    // so a later discard can't destroy it. forgeCommit no-ops on a clean tree.
    const saved = await forgeCommit(ticket.id, `WIP (deps leak) ${ticket.title}`);
    const note = saved
      ? "\n\n[forge: uncommitted work was saved to the sandbox branch as a WIP commit; promote or discard after review]"
      : "";
    await bounce(run, actorId, "deps leak: wrote through shared node_modules link", report + note);
    return settle(run, "failed");
  }
  if (run.stopped) {
    // Same preservation as the worker-failure path below: a stop can land after
    // the worker wrote a complete tree (killTree made runAgent return here). WIP-
    // commit whatever exists so a later sandbox discard can't silently destroy
    // it (live incident: five modified files left uncommitted after a stop).
    // forgeCommit no-ops on a clean tree.
    const saved = await forgeCommit(ticket.id, `WIP (stopped) ${ticket.title}`);
    const note = saved
      ? "\n\n[forge: uncommitted work was saved to the sandbox branch as a WIP commit; promote or discard after review]"
      : "";
    await bounce(run, actorId, "run stopped", note);
    return settle(run, "stopped");
  }
  applyVerification(workRes, run.agents.work, run, config);
  if (!workRes.ok) {
    // Work stage failed after the agent may have written a complete tree (agy's
    // own request timeout self-exits non-zero; the child is already dead here).
    // Commit whatever exists under a WIP marker so hasCommitsToPromote() is true
    // and the operator can promote or discard after review, instead of the run
    // silently throwing away finished-but-uncommitted work. Never auto-promoted;
    // the ticket still bounces to `planned`. forgeCommit no-ops on a clean tree.
    const saved = await forgeCommit(ticket.id, `WIP (worker failed) ${ticket.title}`);
    const note = saved
      ? "\n\n[forge: uncommitted work was saved to the sandbox branch as a WIP commit; promote or discard after review]"
      : "";
    await bounce(run, actorId, "worker failed", workRes.output + note);
    return settle(run, "failed");
  }
  await forgeCommit(ticket.id, ticket.title);
  await addComment(actorId, ticket.id, redactSecrets(workRes.output), "report");
  ticket = await updateTicket(actorId, ticket.id, ticket.version, { status: "review" });

  // review — against the sandbox branch diff. On a rework the plan stage was
  // skipped (stale plan), so change-request comments the supervisor added since
  // that plan are not reflected in it; pass them to the reviewer as authoritative
  // amendments so supervisor-requested scope is not flagged as scope creep.
  const amendments = !planRegenerated && kept.length ? redactSecrets(commentsText) : undefined;
  return reviewStage(run, actorId, agents.review, workdir, sandbox, ticket, plan, workRes.output, styleSetting, config, amendments);
}

function settle(run: Run, status: Status): void {
  run.status = status;
  run.finishedAt = new Date().toISOString();
  emitEvent("run.settled", { runId: run.id, ticketId: run.ticketId, status });
  run.pid = undefined; // a settled row must never look live (S2-A1)
  // Still never allowed to break a pipeline, but the promise is kept so run.done
  // can await it. hasActiveRun consults the DB after the in-memory map goes quiet,
  // so until this row lands a settled run still reads as active. That gap used to
  // be covered by the analyzer's extra await; deleting the analyzer exposed it.
  run.persisted = persistRun(run).catch(() => {});
}

// Extracted for resume-to-review: runs the review stage against an existing sandbox.
async function reviewStage(
  run: Run, actorId: string, reviewAgent: RelayAgent, workdir: string,
  sandbox: string, ticket: Ticket, plan: string, reportOutput: string,
  styleSetting: string, config: RelayConfig, amendments?: string,
): Promise<void> {
  enterStage(run, "review");
  append(run, `\n=== FORGE review (${run.agents.review}) ===\n`);
  const onData = (c: string) => append(run, c);

  if (run.stopped) return settle(run, "stopped");

  // Checks: project static gates run in the SANDBOX (T17 shipped a tsc break —
  // reviewer reads diffs, vitest transpiles without typechecking). Resolved
  // here but not RUN yet: they execute concurrently with the review agent
  // below (once the diff is settled), so a slow check no longer serializes
  // in front of the reviewer's read time. A failing check force-fails the
  // run mechanically at verdict time, independent of the reviewer's own
  // verdict — see the gate evaluation below.
  const checkCmds = resolveChecks(await getSetting("forge.checks"), sandbox);

  // Protected-path policy: deterministic, evaluated on the diff (never the
  // worker's self-report). A touched protected path is an automatic Critical
  // finding that force-fails the review below and blocks promote, unless the
  // ticket body waives it with an ALLOW-PROTECTED: <glob>,<glob> line.
  const protectedGlobs = resolveProtectedPaths(await getSetting("forge.protectedPaths"));
  const allowGlobs = parseAllowProtected(ticket.body ?? "");
  const changedPaths = await sandboxDiffNames(workdir, ticket.id);
  const violations = evaluateProtectedPaths(changedPaths, protectedGlobs, allowGlobs);
  run.protectedViolations = violations.length ? violations : undefined;
  let protectedFinding: string | undefined;
  {
    const lines: string[] = [];
    if (allowGlobs.length) lines.push(`ALLOW-PROTECTED honoured: ${allowGlobs.join(", ")}`);
    if (violations.length) {
      protectedFinding =
        `PROTECTED-PATH VIOLATION (automatic Critical): the work stage modified protected ` +
        `harness/config/audit paths:\n${violations.map((p) => `  - ${p}`).join("\n")}\n` +
        `No ALLOW-PROTECTED allowance in the ticket body covers these; promotion is blocked ` +
        `until a human overrides.`;
      lines.push(protectedFinding);
    }
    if (lines.length) append(run, `\n=== FORGE protected-paths ===\n${lines.join("\n")}\n`);
  }

  // Mechanical gate: secret scan, file-set, mutation probe, AC-map. Runs BEFORE the review model.
  // changedPaths (above) and rangePatch are computed once here and handed to the
  // gate so a single review no longer re-spawns git for the same diff data.
  const rangePatch = await sandboxRangePatch(workdir, ticket.id);
  const gate = await runGate({
    workdir,
    ticketId: ticket.id,
    planText: plan,
    ticketBody: ticket.body ?? "",
    maxSourceFiles: parseInt((await getSetting("forge.mutationProbe.maxSourceFiles")) ?? "", 10) || 3,
    mutationCmd: resolveMutationCmd(await getSetting("forge.mutationProbe.command"), sandbox),
    changedPaths,
    rangePatch,
  });
  const gateBlocked = gate.findings.some(f => f.severity === "block");
  if (gate.report) append(run, `\n=== FORGE gate ===\n${gate.report}\n`);

  if (run.stopped) return settle(run, "stopped");

  const [diff, stat] = await Promise.all([
    sandboxDiff(workdir, ticket.id),
    sandboxDiffSummary(workdir, ticket.id),
  ]);
  // S6: under the cap this is one chunk (the elided diff verbatim -- single-
  // invocation path unchanged). Over the cap, one chunk per directory group,
  // each carrying the whole-diff stat so the reviewer knows what it cannot see.
  const chunks = chunkReviewDiff(elideGeneratedDiffs(diff), stat, DIFF_PROMPT_CAP);

  if (run.stopped) return settle(run, "stopped");

  // Checks run CONCURRENTLY with the whole review (single or chunked): the
  // reviewer only needs check RESULTS at verdict time. Checks execute in
  // `sandbox`; the review agent runs in `workdir`, so no filesystem race.
  const checksStartedAt = checkCmds.length ? Date.now() : undefined;
  const checksPromise: Promise<CheckResult[]> = checkCmds.length
    ? runChecks(checkCmds, sandbox, undefined, (child) => {
        run.checksChild = child;
        if (run.stopped) void killTree(child);
      }).then((results) => { run.checksChild = undefined; return results; })
    : Promise.resolve<CheckResult[]>([]);

  // One review invocation per chunk, sequential: recordSpawn tracks a single
  // live child/pid, and chunked review is the rare oversized-diff path.
  const reviewResults: AgentResult[] = [];
  for (const chunk of chunks) {
    if (run.stopped) { run.child = undefined; return settle(run, "stopped"); }
    const reviewPrompt = composeReviewPrompt({ ticket, plan, report: reportOutput, diff: chunk.payload, operatorNotes: run.operatorNotes, protectedViolation: protectedFinding, amendments, gate: gate.report || undefined, citations: gate.citations || undefined }) + roleStyle("review", styleSetting);
    const res = await track(actorId, ticket.id, "review", run.agents.review, reviewPrompt.length, () => runAgent(
      reviewAgent,
      reviewPrompt,
      workdir, onData,
      (child) => recordSpawn(run, child),
    ));
    reviewResults.push(res);
  }
  run.child = undefined;
  const checkResults = await checksPromise;
  if (checksStartedAt !== undefined) run.checksDurationMs = Date.now() - checksStartedAt;
  if (run.stopped) return settle(run, "stopped");

  let checksText: string | undefined;
  let checksFailed = false;
  if (checkCmds.length) {
    checksText = redactSecrets(formatChecks(checkResults));
    checksFailed = checkResults.some((r) => r.code !== 0);
    append(run, `\n=== FORGE checks ===\n${checksText}\n`);
  }

  for (const res of reviewResults) applyVerification(res, run.agents.review, run, config);
  const verdict = mergeReviewVerdicts(chunks, reviewResults.map((r) => r.output));

  // Gate block or a failing check forces FAIL regardless of the model's verdict
  const pass = verdict.pass && !gateBlocked && !checksFailed;
  const checksBlockNote = (!gateBlocked && checksFailed)
    ? `\n\n[forge: check(s) failed — verdict forced to FAIL]\n${checksText}\nVERDICT: FAIL`
    : "";
  const reviewBody = gateBlocked
    ? `${verdict.raw}\n\n[forge: mechanical gate BLOCK — verdict forced to FAIL]\n${gate.report}\nVERDICT: FAIL`
    : `${verdict.raw}${checksBlockNote}`;
  await addComment(actorId, ticket.id, redactSecrets(reviewBody), "review");

  if (!pass) {
    // FAIL: back to planned; sandbox kept for the rework pass. The run settles
    // "rejected" (not "passed") so the quality signal reflects the verdict, not
    // pipeline completion.
    await updateTicket(actorId, ticket.id, ticket.version, { status: "planned" });
    return settle(run, "rejected");
  }
  // PASS: ticket STAYS in review — promotion is a human action.
  settle(run, "passed");
}

// Single choke point for run-history rows. Best-effort: comments already hold
// the durable plan/report/review record, this is just for the runs list.
async function persistRun(run: Run): Promise<void> {
  try {
    const finishedAt = run.finishedAt ? new Date(run.finishedAt) : undefined;
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
      startedAt: new Date(run.startedAt),
      finishedAt,
    }).onConflictDoUpdate({
      target: forgeRuns.id,
      set: { status: run.status, stage: run.stage, finishedAt, protectedViolations: run.protectedViolations ?? null, checksDurationMs: run.checksDurationMs ?? null, pid: run.pid ?? null }
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

async function getKnowledgeSafe(q: string, projectId?: string): Promise<{ content: string; citation: string }[]> {
  try { return await searchKnowledge(q, { limit: 5, projectId, caller: "forge:run" }); } catch { return []; }
}

function trim(): void {
  const finished = [...runs.values()].filter((r) => r.status !== "running")
    .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
  for (const r of finished.slice(KEEP_FINISHED)) runs.delete(r.id);
}

// capsOverride exists for tests: the per-day cap is inherently global, and a
// test persisting it in the shared settings DB throttles every parallel
// pipeline in the suite (live-hit).
export async function checkBudget(
  ticketId: string,
  capsOverride?: { perTicket?: number; perDay?: number },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const perTicketSetting = capsOverride ? String(capsOverride.perTicket ?? "") : (await getSetting("ai.budget.perTicketTokens"));
  const perDaySetting = capsOverride ? String(capsOverride.perDay ?? "") : (await getSetting("ai.budget.perDayTokens"));

  const perTicketCap = parseInt(perTicketSetting || "", 10);
  const perDayCap = parseInt(perDaySetting || "", 10);

  if (!isNaN(perTicketCap)) {
    const [row] = await db.select({ total: sum(aiUsageLogs.tokens) }).from(aiUsageLogs).where(eq(aiUsageLogs.ticketId, ticketId));
    const total = Number(row?.total || 0);
    if (total > perTicketCap) {
      return { ok: false, reason: `per-ticket token cap exceeded: ${total} > ${perTicketCap}` };
    }
  }

  if (!isNaN(perDayCap)) {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const [row] = await db.select({ total: sum(aiUsageLogs.tokens) }).from(aiUsageLogs).where(gte(aiUsageLogs.createdAt, startOfDay));
    const total = Number(row?.total || 0);
    if (total > perDayCap) {
      return { ok: false, reason: `per-day token cap exceeded: ${total} > ${perDayCap}` };
    }
  }

  return { ok: true };
}

export function listRuns(): RunSummary[] {
  return [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(summarize);
}

export function activeStageForTicket(ticketId: string): Stage | undefined {
  return activeRuns().find((r) => r.ticketId === ticketId)?.stage;
}

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

// In-memory active run for any ticket in the project, if one exists. Used to
// block project deletion (killing a project mid-run would orphan the sandbox and
// the in-memory Run). Returns the offending run id, else null.
export async function activeRunForProject(projectId: string): Promise<string | null> {
  const active = activeRuns();
  if (!active.length) return null;
  const rows = await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.projectId, projectId));
  const ids = new Set(rows.map((r) => r.id));
  return active.find((r) => ids.has(r.ticketId))?.id ?? null;
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

export type RunListItem = RunSummary & { persisted?: boolean; modelVerified?: boolean | "unknown"; rejectionReason?: string; stageDurationsMs?: StageDurationsMs };

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
      effort: (r.effort ?? undefined) as Effort | undefined,
      checksDurationMs: r.checksDurationMs ?? undefined,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : undefined,
      persisted: true,
    }));
  const list: RunListItem[] = [...live, ...persisted]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, LIST_CAP);

  const enrichPromises = list.map(async (item) => {
    item.modelVerified = await computeVerificationStatus(item.ticketId, {
      from: new Date(item.startedAt),
      to: item.finishedAt ? new Date(item.finishedAt) : null,
    });
    if (item.status !== "running" && item.finishedAt) {
      item.stageDurationsMs = await deriveStageDurations(
        item.ticketId, new Date(item.startedAt), new Date(item.finishedAt), item.checksDurationMs,
      );
    }
    if (item.status === "rejected") {
      const comments = await listComments(item.ticketId);
      const from = new Date(item.startedAt).getTime();
      const to = item.finishedAt ? new Date(item.finishedAt).getTime() : Date.now();
      const review = [...comments].reverse().find(
        (c) => c.kind === "review" &&
          new Date(c.createdAt).getTime() >= from &&
          new Date(c.createdAt).getTime() <= to,
      );
      if (review) item.rejectionReason = parseReason(review.body);
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

// Test-teardown hook: resolve once every in-flight run has fully settled. Deleting a
// workdir while a run is still winding down (later stages, analyzer, git) EPERMs on
// Windows. Production never needs this - stop stays prompt.
export async function settleAll(): Promise<void> {
  await Promise.allSettled([...runs.values()].map((r) => r.done));
}

export async function stopRun(id: string): Promise<boolean> {
  const r = runs.get(id);
  if (!r || r.status !== "running") return false;
  r.stopped = true; // checked between stages so a running stage still lands on "stopped"
  if (r.child) await killTree(r.child);
  if (r.checksChild) await killTree(r.checksChild);
  if (r.abort) r.abort();
  return true;
}

export function awaitRun(id: string): Promise<void> {
  return runs.get(id)?.done ?? Promise.resolve();
}

export async function markInterruptedRuns(): Promise<string[]> {
  try {
    const rows = await db.update(forgeRuns)
      .set({ status: "interrupted", finishedAt: new Date() })
      .where(isNull(forgeRuns.finishedAt))
      .returning({ ticketId: forgeRuns.ticketId });
    bump("runs.interrupted", rows.length);
    return rows.map((r) => r.ticketId);
  } catch (e) {
    console.warn("forge: failed to mark interrupted runs:", (e as Error).message);
    return [];
  }
}

const RECONCILE_COMMENT = "forge: reconcile — code was already merged to the workdir and the last run passed review, but the ticket-close was lost (server restart mid-promote). Closing to match master.";

// Boot-time heal for the lost-promote-close race: promote merges the sandbox, then
// closes the ticket — a restart between the two leaves a REVIEW ticket whose code is
// already on master. Close any review/in_progress ticket whose branch is fully merged
// (no commits beyond workdir HEAD) and whose latest run passed. Per-ticket try/catch:
// a missing workdir/branch, stale version, or verification-required close just skips.
export async function reconcileMergedTickets(): Promise<string[]> {
  const admin = (await listActors()).find((a) => a.role === "admin");
  if (!admin) return [];
  const config = loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG);
  const rows = await db.select().from(tickets)
    .where(inArray(tickets.status, ["review", "in_progress"]));
  const closed: string[] = [];
  for (const ticket of rows) {
    try {
      if ((await latestRunStatus(ticket.id)) !== "passed") continue; // no passing run -> leave it
      const workdir = await resolveWorkdir(ticket.projectId, config);
      if (await hasCommitsToPromote(workdir, ticket.id)) continue; // unmerged -> not promoted yet
      await addComment(admin.id, ticket.id, RECONCILE_COMMENT, "comment");
      await updateTicket(admin.id, ticket.id, ticket.version, { status: "closed" });
      closed.push(ticket.id);
    } catch {
      // boot must never crash on one bad ticket
    }
  }
  return closed;
}

export type RecoveryItem = {
  runId: string; ticketId: string; ticketTitle: string; stage: Stage;
  sandboxExists: boolean; hasCommits: boolean;
  resumable: boolean; resumeMode: "plan" | "work" | "review" | null;
  reason: string; startedAt: string;
};

// Terminal run states whose on-disk work (sandbox, WIP commit, branch) is still
// recoverable. `interrupted` is boot crash-recovery; `failed`/`stopped` are the
// common case (agent rate-limit, self-exit, operator stop). `passed`/`rejected`
// are excluded: passed succeeded, rejected already bounced the ticket to planned.
const RESUMABLE_STATUSES = new Set<Status>(["interrupted", "failed", "stopped"]);

// Interrupted runs still worth recovering: latest run per ticket, only if that
// latest run is itself interrupted (a newer run supersedes it). Read-only —
// computes disk truth (sandbox, branch commits) but never starts anything.
export async function listInterruptedRuns(config: RelayConfig): Promise<RecoveryItem[]> {
  const rows = await db.select().from(forgeRuns).orderBy(desc(forgeRuns.startedAt)).limit(60);
  const latestByTicket = new Map<string, typeof rows[number]>();
  for (const r of rows) if (!latestByTicket.has(r.ticketId)) latestByTicket.set(r.ticketId, r);
  const items: RecoveryItem[] = [];
  for (const r of latestByTicket.values()) {
    if (!RESUMABLE_STATUSES.has(r.status as Status)) continue;
    let ticket; try { ticket = await getTicket(r.ticketId); } catch { continue; }
    if (ticket.status === "closed") continue;
    const workdir = await resolveWorkdir(ticket.projectId, config).catch(() => config.workdir);
    const sbx = sandboxExists(r.ticketId);
    const commits = await hasCommitsToPromote(workdir, r.ticketId).catch(() => false);
    const stage = r.stage as Stage;
    let resumeMode: RecoveryItem["resumeMode"] = null, resumable = false, reason = "";
    if (stage === "plan") {
      resumeMode = "plan"; resumable = true;
      reason = "died during planning; no sandbox exists yet — resume restarts the pipeline from planning";
    } else if (stage === "work") {
      if (commits) {
        // A work commit exists on the branch — offer review against it instead of
        // re-running the whole work stage and paying twice. The commit MAY be a
        // partial WIP (a sentinel/timeout can fire mid-diff), so the reason names
        // the tradeoff: review of a half-diff FAILS and tells the operator, which
        // is cheaper than re-running work and silently discarding a good diff.
        resumeMode = "review"; resumable = true;
        reason = "died during work but a work commit already exists on the sandbox branch — resume goes straight to review against it, no work re-run. Note: a work commit can be a partial WIP, so review may fail on a half-diff; use Retry to re-run the full work stage from the plan instead.";
      } else {
        resumeMode = "work"; resumable = true;
        reason = sbx
          ? "died during work; sandbox has uncommitted partial edits and the agent context is gone — resume re-runs the work stage from the plan (not mid-stage)"
          : "died during work; sandbox is no longer on disk — resume starts the work stage fresh";
      }
    } else { // review
      if (commits) {
        resumeMode = "review"; resumable = true;
        reason = "died during review; work committed a complete diff — resume goes straight to review against the existing sandbox, no work re-run";
      } else {
        resumeMode = null; resumable = false;
        reason = "died during review but the committed sandbox is gone — nothing to review; start a new run instead";
      }
    }
    items.push({
      runId: r.id, ticketId: r.ticketId, ticketTitle: ticket.title, stage,
      sandboxExists: sbx, hasCommits: commits, resumable, resumeMode,
      reason, startedAt: r.startedAt.toISOString(),
    });
  }
  return items;
}
