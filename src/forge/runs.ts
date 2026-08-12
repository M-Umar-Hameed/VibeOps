import { randomUUID } from "node:crypto";
import { getLessons, lessonsClause, composeAnalyzerPrompt, parseProposal, formatProposal, recordProposal } from "./lessons.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { resolveCmd, type RelayConfig, type RelayAgent } from "../relay/config.js";
import { pipelineStartWarnings, pipelineStartBlockingError } from "../relay/doctor.js";
import { roleStyle } from "../relay/style.js";
import { composePlanPrompt, composeWorkPrompt, composeReviewPrompt, parseVerdict, fenceUntrusted } from "../relay/prompts.js";
import { killTree, type AgentResult } from "../relay/invoke.js";
import { runAgent } from "../relay/dispatch.js";
import { redactSecrets } from "./redact.js";
import { ensureSandbox, forgeCommit, sandboxDiff, sandboxDiffSummary, sandboxDiffNames, sandboxExists, hasCommitsToPromote, snapshotDeps, detectDepsLeak, discardSandbox, listSandboxTicketIds, sandboxSizeBytes, isLiveWorktree } from "./sandbox.js";
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
import { desc, isNull, sum, eq, gte, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { forgeRuns, aiUsageLogs, tickets, type Ticket } from "../db/schema.js";
import { verifyModel, MISMATCH_WARNING, computeVerificationStatus } from "./verify.js";
import { resolveChecks, runChecks, formatChecks } from "./checks.js";

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
export function reviewDiffPayload(fullDiff: string, stat: string, cap = DIFF_PROMPT_CAP): string {
  if (fullDiff.length <= cap) return fullDiff;
  return `[diff too large: showing stat + first ${cap / 1000}k chars]\n${stat}\n\n${fullDiff.slice(0, cap)}`;
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
  output: string; startedAt: string; finishedAt?: string;
  child?: ChildProcess; // the in-flight agent CLI for the current stage, if any
  abort?: () => void;   // in-loop sdk lane's AbortController.abort, if any
  stopped: boolean;
  done: Promise<void>;
};

const runs = new Map<string, Run>();

export type RunSummary = Omit<Run, "output" | "child" | "abort" | "stopped" | "done">;

function summarize(r: Run): RunSummary {
  const { output, child, abort, stopped, done, ...rest } = r;
  void output; void child; void abort; void stopped; void done;
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

function activeRuns(): Run[] {
  return [...runs.values()].filter((r) => r.status === "running");
}

// Wraps a stage's runAgent call with an agent_sessions row (start/end) and an
// ai_usage_logs row (estimated tokens from output length). Never throws.
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

export type SandboxCleanupResult = { discarded: string[]; reclaimedBytes: number; orphans: string[] };

// Manual backlog sweep: discard every on-disk sandbox whose ticket is CLOSED and
// whose forge branch has no commits beyond the project workdir HEAD (already merged
// / pure dead weight). Skips active-run tickets, non-closed tickets, orphan sandboxes
// with no ticket, and any branch still carrying unmerged commits. Removal goes through
// discardSandbox so the deps-unlink-before-delete SAFETY ordering is preserved.
export async function cleanupMergedSandboxes(config: RelayConfig): Promise<SandboxCleanupResult> {
  const discarded: string[] = [];
  const orphans: string[] = [];
  let reclaimedBytes = 0;
  for (const ticketId of listSandboxTicketIds()) {
    if (await hasActiveRun(ticketId)) continue;
    // A directory git has no record of -- an empty dir from an interrupted run, or
    // a partial tree left by a failed worktree removal (missing .git) -- is
    // reclaimable disk but must NOT have worktree commands run against it: that git
    // failure is what aborted the sweep mid-run. Report it as an orphan and carry on.
    if (!isLiveWorktree(ticketId)) { orphans.push(ticketId); continue; }
    let ticket;
    try { ticket = await getTicket(ticketId); } catch { orphans.push(ticketId); continue; } // live worktree, ticket row lost
    if (ticket.status !== "closed") continue;
    const workdir = await resolveWorkdir(ticket.projectId, config);
    if (await hasCommitsToPromote(workdir, ticketId)) continue; // unmerged work -> keep
    const bytes = sandboxSizeBytes(ticketId);
    await discardSandbox(workdir, ticketId);
    discarded.push(ticketId);
    reclaimedBytes += bytes;
  }
  return { discarded, reclaimedBytes, orphans };
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


  const run: Run = {
    id: randomUUID(), ticketId: opts.ticketId, stage: "plan", status: "running",
    agents: { plan: composite(planPick), work: composite(workPick), review: composite(reviewPick) },
    operatorNotes: opts.operatorNotes?.slice(0, MAX_OPERATOR_NOTES),
    effort: opts.effort,
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
  // Analyzer runs AFTER any settle path and INSIDE run.done: the run is already
  // settled for pollers, and awaitRun covers the analyzer (a detached spawn
  // held test workdirs as its cwd during cleanup — Windows EPERM).
  }).then(() => analyzeRun(run, actorId, config)).catch(() => {});
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
    append(run, `=== FORGE plan (${run.agents.plan}) ===\n`);
    const knowledge = await getKnowledgeSafe(ticket.title, ticket.projectId);
    const planPrompt = composePlanPrompt({ ticket, knowledge }) + PLAN_ONLY + lessons + roleStyle("plan", styleSetting) + extra;
    const res = await track(actorId, ticket.id, "plan", run.agents.plan, planPrompt.length, () => runAgent(
      agents.plan, planPrompt, workdir, onData,
      (child) => { run.child = child; },
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
  run.stage = "work";
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
      (child) => { run.child = child; }, (abort) => { run.abort = abort; },
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
    await bounce(run, actorId, "sandbox escape: protected path written outside the worktree", report);
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
    await bounce(run, actorId, "deps leak: wrote through shared node_modules link", report);
    return settle(run, "failed");
  }
  if (run.stopped) { await bounce(run, actorId, "run stopped", ""); return settle(run, "stopped"); }
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
  void persistRun(run); // fire-and-forget: history must never break a pipeline
}

// Extracted for resume-to-review: runs the review stage against an existing sandbox.
async function reviewStage(
  run: Run, actorId: string, reviewAgent: RelayAgent, workdir: string,
  sandbox: string, ticket: Ticket, plan: string, reportOutput: string,
  styleSetting: string, config: RelayConfig, amendments?: string,
): Promise<void> {
  run.stage = "review";
  append(run, `\n=== FORGE review (${run.agents.review}) ===\n`);
  const onData = (c: string) => append(run, c);

  // Checks: project static gates run in the SANDBOX (T17 shipped a tsc break —
  // reviewer reads diffs, vitest transpiles without typechecking). A failing
  // check never hard-fails the run; the reviewer judges it.
  const checkCmds = resolveChecks(await getSetting("forge.checks"), sandbox);
  let checksText: string | undefined;
  if (checkCmds.length) {
    append(run, `\n=== FORGE checks ===\n`);
    const checkResults = await runChecks(checkCmds, sandbox, undefined, (child) => { run.child = child; });
    run.child = undefined;
    if (run.stopped) return settle(run, "stopped");
    checksText = redactSecrets(formatChecks(checkResults));
    append(run, checksText + "\n");
  }

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

  const diff = await sandboxDiff(workdir, ticket.id);
  const stat = await sandboxDiffSummary(workdir, ticket.id);
  const reviewPrompt = composeReviewPrompt({ ticket, plan, report: reportOutput, diff: reviewDiffPayload(diff, stat), operatorNotes: run.operatorNotes, checks: checksText, protectedViolation: protectedFinding, amendments }) + roleStyle("review", styleSetting);
  const reviewRes = await track(actorId, ticket.id, "review", run.agents.review, reviewPrompt.length, () => runAgent(
    reviewAgent,
    reviewPrompt,
    workdir, onData,
    (child) => { run.child = child; },
  ));
  run.child = undefined;
  if (run.stopped) return settle(run, "stopped");
  applyVerification(reviewRes, run.agents.review, run, config);
  const verdict = parseVerdict(reviewRes.output);
  await addComment(actorId, ticket.id, redactSecrets(verdict.raw), "review");
  if (!verdict.pass) {
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
      startedAt: new Date(run.startedAt),
      finishedAt,
    }).onConflictDoUpdate({
      target: forgeRuns.id,
      set: { status: run.status, stage: run.stage, finishedAt, protectedViolations: run.protectedViolations ?? null }
    });
  } catch (e) {
    console.warn(`forge: failed to persist run ${run.id}:`, (e as Error).message);
  }
}

// Studies the settled run's narrated output and records a PROPOSED prompt-lessons
// document in the separate prompt-lessons-proposals note. Advisory-only: it never
// writes the live prompt-lessons note. Opt-in, fire-and-forget, never blocks a pipeline.
async function analyzeRun(run: Run, actorId: string, config: RelayConfig): Promise<void> {
  try {
    if ((await getSetting("prompts.selfImprove")) !== "true") return;
    const pick = pickAgents(config, "cheapest-first").plan;
    const agent = { ...getAgent(config, pick.agent, "plan") };
    agent.cmd = resolveCmd(agent, pick.model);

    const prompt = composeAnalyzerPrompt({
      output: run.output.slice(0, 30_000),
      outcome: `status=${run.status} stage=${run.stage}`,
    });
    const res = await runAgent(agent, prompt, config.workdir);
    const proposal = parseProposal(res.output);
    if (proposal === null) {
      console.warn("forge: analyzer parsed null proposal");
      return;
    }
    await recordProposal(actorId, formatProposal(proposal));
  } catch (e) {
    console.warn(`forge: analyzer failed for run ${run.id}:`, (e as Error).message);
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

export type RunListItem = RunSummary & { persisted?: boolean; modelVerified?: boolean | "unknown" };

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
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : undefined,
      persisted: true,
    }));
  const list: RunListItem[] = [...live, ...persisted]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, LIST_CAP);

  const verificationPromises = list.map(async (item) => {
    item.modelVerified = await computeVerificationStatus(item.ticketId, {
      from: new Date(item.startedAt),
      to: item.finishedAt ? new Date(item.finishedAt) : null,
    });
  });
  await Promise.all(verificationPromises);

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
    return rows.map((r) => r.ticketId);
  } catch (e) {
    console.warn("forge: failed to mark interrupted runs:", (e as Error).message);
    return [];
  }
}

export type RecoveryItem = {
  runId: string; ticketId: string; ticketTitle: string; stage: Stage;
  sandboxExists: boolean; hasCommits: boolean;
  resumable: boolean; resumeMode: "plan" | "work" | "review" | null;
  reason: string; startedAt: string;
};

// Interrupted runs still worth recovering: latest run per ticket, only if that
// latest run is itself interrupted (a newer run supersedes it). Read-only —
// computes disk truth (sandbox, branch commits) but never starts anything.
export async function listInterruptedRuns(config: RelayConfig): Promise<RecoveryItem[]> {
  const rows = await db.select().from(forgeRuns).orderBy(desc(forgeRuns.startedAt)).limit(60);
  const latestByTicket = new Map<string, typeof rows[number]>();
  for (const r of rows) if (!latestByTicket.has(r.ticketId)) latestByTicket.set(r.ticketId, r);
  const items: RecoveryItem[] = [];
  for (const r of latestByTicket.values()) {
    if (r.status !== "interrupted") continue;
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
      resumeMode = "work"; resumable = true;
      reason = sbx
        ? "died during work; sandbox has uncommitted partial edits and the agent context is gone — resume re-runs the work stage from the plan (not mid-stage)"
        : "died during work; sandbox is no longer on disk — resume starts the work stage fresh";
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
