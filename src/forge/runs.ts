import { randomUUID } from "node:crypto";
import { getLessons, lessonsClause } from "./lessons.js";
import { existsSync, statSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { vibeopsHome } from "../runtime/home.js";
import { startTimeReader } from "../runtime/proc-start.js";
import { resolveCmd, loadRelayConfig, type RelayConfig, type RelayAgent } from "../relay/config.js";
import { pipelineStartWarnings, pipelineStartBlockingError } from "../relay/doctor.js";
import { parseVerdict } from "../relay/prompts.js";
import { killTree, killPidTree } from "../relay/invoke.js";
import { availableAccount } from "../relay/accounts.js";
import { hasCommitsToPromote, discardSandbox, listSandboxTicketIds, sandboxSizeBytes, isLiveWorktree, deleteOrphanIfLinkFree, pruneWorktreeRegistrations, listForgeBranches, deleteMergedBranch, viewsRoot, sandboxExists, checkSandboxDisk, diskFullMessage, DiskFullError } from "./sandbox.js";
import { pickAgents, escalate, pairsForRole, resolveStrategy, type Pick, type RoutingStrategy } from "./router.js";
import { updateTicket } from "../services/tickets.js";
import { addComment, listComments } from "../services/comments.js";
import { getTicket } from "../services/history.js";
import { indexRepoDocs, repoIndexed } from "../services/knowledge.js";
import { getSetting } from "../services/settings.js";
import { projectWorkdir } from "../services/projects.js";
import { ConflictError } from "../services/errors.js";
import { listActors } from "../services/actors.js";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { forgeRuns, tickets } from "../db/schema.js";
import { type Run, type Stage, type Status, type Effort, runs, append, activeRuns, setCause, settle, bounce, persistRun, trim } from "./run-state.js";
import { getAgent, composite, parsePair, checkBudget } from "./run-agents.js";
import { BASE_CONFLICT } from "./review-stage.js";
import { pipeline, resolveMinFreeBytes } from "./run-pipeline.js";
import { hasActiveRun, latestRunStatus } from "./run-queries.js";

export { RUN_STATUSES, type Effort, type RunSummary } from "./run-state.js";
export { parsePair, checkBudget } from "./run-agents.js";
export { knowledgeQuery, rankForgeKnowledge } from "./run-knowledge.js";
export { resolveMaxConcurrentChecks, DIFF_PROMPT_CAP, elideGeneratedDiffs, reviewDiffPayload } from "./review-stage.js";
export { resolveMinFreeBytes, NARRATION } from "./run-pipeline.js";
export { listRuns, activeStageForTicket, hasAnyActiveRun, hasActiveRun, latestRunStatus, latestRunPolicy, markPolicyWaived, listRunsWithHistory, getRunOutput, getSettledRunOutput, getRunTimings, settleAll, awaitRun, type RunPolicy, type StageDurationsMs, type RunListItem, type RunListOpts } from "./run-queries.js";
export { resolveStallWindowMs, logSizeReader, sweepStalledRuns, sweepStalledRunsWithConfig } from "./stall-sweep.js";
export { markInterruptedRuns } from "./run-reattach.js";

// forge.maxActiveRuns: positive-integer cap on concurrent runs. Malformed or
// unset falls back to the default so a bad setting can never break run start.
const DEFAULT_MAX_ACTIVE = 3;
export function resolveMaxActive(setting: string | null): number {
  const n = parseInt(setting ?? "", 10);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_ACTIVE;
}

const MAX_EXTRA_PROMPT = 10_000;
const MAX_OPERATOR_NOTES = 2000;

async function countFailedReviews(ticketId: string): Promise<number> {
  const comments = await listComments(ticketId);
  const sincePlan = comments.slice(comments.map((c) => c.kind).lastIndexOf("plan") + 1);
  return sincePlan.filter((c) => c.kind === "review" && !c.body.startsWith(BASE_CONFLICT) && !parseVerdict(c.body).pass).length;
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
  // Views are removed when their stage ends; one a Windows lock kept alive is
  // reclaimed here. ponytail: age-based, views have no owner record; a live-view
  // registry is the upgrade path if a stage ever runs longer than 24 hours.
  const viewCutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of existsSync(viewsRoot()) ? readdirSync(viewsRoot()) : []) {
    const p = join(viewsRoot(), name);
    try { if (statSync(p).mtimeMs < viewCutoff) rmSync(p, { recursive: true, force: true }); } catch {}
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
    resumeStage?: Stage; limitRetry?: boolean; escalate?: boolean;
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

  // Only "balanced" means the owner expressed no preference, so that is the only
  // case the local model may refine. An explicit cost/max setting and an explicit
  // per-run effort both outrank it and are never overridden.
  let routing = strategy;
  if (strategy === "balanced" && !effortStrategy) {
    try {
      const t = await getTicket(opts.ticketId);
      routing = await resolveStrategy(strategy, { title: t.title, body: t.body });
    } catch { /* keep balanced: routing must never block a run */ }
  }

  const getAuto = () => (auto ??= pickAgents(config, effortStrategy ?? routing));

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

  let escalated = "";
  if (opts.workAgent === "auto" && (effortStrategy || !defaults.work)
    && (opts.escalate === true || (await getSetting("forge.escalate")) === "true")) {
    const attempts = await countFailedReviews(opts.ticketId);
    const next = escalate(pairsForRole(config, "work"), workPick, attempts);
    if (composite(next) !== composite(workPick)) {
      escalated = `\nforge: escalated work ${composite(workPick)} -> ${composite(next)} after ${attempts} failed reviews\n`;
    }
    workPick = next;
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
  // sdk/http agents carry no cmd to substitute a model into -- sdk gets its model
  // via the dispatch model param below, http via runHttpAgent's model argument.
  const resolveIfCli = (a: RelayAgent, m?: string) => (a.type === "sdk" || a.type === "http") ? (a.cmd ?? []) : resolveCmd(a, m);
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
  const workdir = await resolveWorkdir(ticket.projectId, config);
  if (opts.resumeStage === "review") {
    // Resume-to-review skips plan+work and reviews the existing sandbox commit.
    // Its precondition is a promotable work commit, not a specific ticket status:
    // a run that died in work leaves the ticket `planned` (bounced), one that died
    // in review leaves it `review`. Gate on the commit so recovery's "review" mode
    // is honoured for both, while a sandbox with nothing to review is still refused.
    if (!(await hasCommitsToPromote(workdir, opts.ticketId).catch(() => false))) {
      throw new ConflictError(`ticket ${opts.ticketId} has no work commit to review`);
    }
  } else {
    const allowed = opts.resumeStage === "work"
      ? ["open", "planned", "in_progress"]
      : ["open", "planned"];
    if (!allowed.includes(ticket.status)) {
      throw new ConflictError(`ticket is ${ticket.status}; pipeline needs ${allowed.join(" or ")}`);
    }
  }

  if (await projectWorkdir(ticket.projectId)) {
    if (!(await repoIndexed(ticket.projectId))) {
      indexRepoDocs(ticket.projectId)
        .catch((e) => console.warn(`repo index failed: ${(e as Error).message}`)); // non-blocking
    }
  }

  const minFreeBytes = resolveMinFreeBytes(await getSetting("forge.minFreeDiskMb"));
  const disk = checkSandboxDisk(minFreeBytes);
  if (!disk.ok) throw new ConflictError(diskFullMessage(disk, minFreeBytes));

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
  if (escalated) append(run, escalated);
  await persistRun(run);
  run.done = pipeline(run, actorId, agents, workdir, styleSetting ?? "", lessons, config, opts.extraPrompt, opts.resumeStage).catch(async (e) => {
    append(run, `\nforge: pipeline error: ${(e as Error).message}\n`);
    // Uphold the never-stuck-in_progress invariant even for unexpected throws
    // (forgeCommit/addComment failures land here, after the claim).
    await bounce(run, actorId, `pipeline error: ${(e as Error).message}`, "");
    if (e instanceof DiskFullError) {
      setCause(run, "disk_full", e.message);
    } else {
      setCause(run, "pipeline_error", `pipeline error: ${(e as Error).message}`);
    }
    settle(run, "failed");
  }).then(() => run.persisted).catch(() => {})
    .then(() => opts.limitRetry ? undefined : retryOnNextAccount(run, actorId, config, agents, {
      ...opts, planAgent: planPick.agent, planModel: planPick.model, workAgent: workPick.agent, workModel: workPick.model,
      reviewAgent: reviewPick.agent, reviewModel: reviewPick.model,
    }))
    .catch((e) => append(run, `\nforge: usage-limit retry not started: ${(e as Error).message}\n`));
  return { runId: run.id, doctorWarnings };
}

// A run that failed because its account hit a usage limit is resumed once on the
// next account of the SAME lane and model (accounts.ts skips the exhausted login).
// Resume mode comes from listInterruptedRuns: a work commit goes straight to review.
// Every account exhausted: the failure stands. Never switches provider or model.
async function retryOnNextAccount(
  run: Run, actorId: string, config: RelayConfig,
  agents: { plan: RelayAgent; work: RelayAgent; review: RelayAgent },
  opts: Parameters<typeof startPipeline>[2],
): Promise<void> {
  if (run.status !== "failed" || run.stopped || !run.limit) return;
  const { role, account } = run.limit;
  const agent = agents[role];
  const next = (await availableAccount(agent)).account;
  if (!next) return;
  const item = (await listInterruptedRuns(config, run.ticketId))[0];
  if (!item || item.runId !== run.id || !item.resumable || !item.resumeMode) return;
  const from = agent.accounts?.find((a) => a.id === account)?.label ?? account;
  const line = `\nforge: usage limit on account ${from}, continuing on ${next.label}\n`;
  append(run, line);
  const { runId } = await startPipeline(actorId, config, {
    ...opts, resumeStage: item.resumeMode === "plan" ? undefined : item.resumeMode, limitRetry: true,
  });
  const retry = runs.get(runId);
  if (retry) append(retry, line);
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

export async function stopRun(id: string): Promise<boolean> {
  const r = runs.get(id);
  if (!r || r.status !== "running") return false;
  r.stopped = true; // checked between stages so a running stage still lands on "stopped"
  if (r.child) await killTree(r.child);
  else if (r.pid) await killPidTree(r.pid);
  if (r.checksChild) await killTree(r.checksChild);
  if (r.abort) r.abort();
  return true;
}

export { startTimeReader };

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
export async function listInterruptedRuns(config: RelayConfig, ticketId?: string): Promise<RecoveryItem[]> {
  const rows = ticketId
    ? await db.select().from(forgeRuns).where(eq(forgeRuns.ticketId, ticketId)).orderBy(desc(forgeRuns.startedAt)).limit(1)
    : await db.select().from(forgeRuns).orderBy(desc(forgeRuns.startedAt)).limit(60);
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
    if (r.cause === "disk_full") {
      reason = "disk full on the sandbox volume; free space, then start again";
    } else if (stage === "plan") {
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
