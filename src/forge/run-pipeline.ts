import { isSlmWorker, evaluateTaskSizing, atomicDirective } from "./sizing.js";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { type RelayConfig, type RelayAgent } from "../relay/config.js";
import { roleStyle } from "../relay/style.js";
import { composePlanPrompt, composeWorkPrompt, fenceUntrusted, type ReworkContext } from "../relay/prompts.js";
import { loadWall, agyFirewallHookCommand } from "../relay/wall.js";
import { withAgyHook } from "./agy-hook.js";
import { listSkills, formatSkillIndex, formatSkillBodies, parseOperatorSkills, parsePlanSkills, parseSkillAllowlist, skillsForAgent, type SkillMeta } from "./skills.js";
import { type AgentResult } from "../relay/invoke.js";
import { runAgent } from "../relay/dispatch.js";
import { redactSecrets } from "./redact.js";
import { ensureSandbox, forgeCommit, sandboxDiffNamesNoRenames, sandboxExists, snapshotDeps, detectDepsLeak, withReadOnlyView, resolveDepsDirs, resolveFrontendDeps, listExportOutputs, attachmentsDir, EVIDENCE_MAX_BYTES, stageOperatorEvidence, mirrorOperatorEvidence, OPERATOR_EVIDENCE_MAX_FILES, OPERATOR_EVIDENCE_MAX_TOTAL, sandboxHeadHash, syncSandboxWithBase } from "./sandbox.js";
import { resolveSensitivePaths, snapshotSensitive, detectAndRestore } from "./sentinel.js";
import { stripGateDirectives, parseExportTo, parseEvidence, parseAllowCommand } from "./policy.js";
import { RISK_IDS } from "../relay/risk.js";
import { updateTicket } from "../services/tickets.js";
import { addComment, listComments } from "../services/comments.js";
import { getTicket, getTicketHistory } from "../services/history.js";
import { getSetting } from "../services/settings.js";
import { getProjectSettings } from "../services/projects.js";
import { StaleVersionError } from "../services/errors.js";
import { listActors } from "../services/actors.js";
import { captureMemory, reportTail } from "../services/memory-capture.js";
import { type Ticket } from "../db/schema.js";
import { resolveChecks, runChecks, formatChecks, selectChecks } from "./checks.js";
import { declaredFullPaths, overlappingDeclared } from "./gate.js";
import { type Run, type Stage, append, enterStage, recordSpawn, setCause, settle, bounce, setStatus, activeRuns } from "./run-state.js";
import { track, noteAccount, modelOf, applyVerification } from "./run-agents.js";
import { knowledgeQuery, getKnowledgeSafe, getMemorySafe } from "./run-knowledge.js";
import { reviewStage, baseSyncLine, type OperatorEvidence } from "./review-stage.js";

const DEFAULT_MIN_FREE_MB = 2048;
export function resolveMinFreeBytes(setting: string | null): number {
  const n = Number(setting);
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_MIN_FREE_MB) * 1024 * 1024;
}

// Was 2000 and shared across all requests, which was smaller than a single
// detailed request -- one review round could exhaust it on its own.
const CHANGE_REQUEST_BUDGET = 12_000;

export const NARRATION =
  "\n\nBefore each step, print what you are about to do and why. " +
"Your progress log is read live by the supervisor and by the reviewing model." +
  // Absolute paths make sandboxed workers write at the REAL repo, which their
  // own workspace security then denies (live incident: agy asked for write
  // approval on D:\...\src, wrote nothing, and reported success anyway).
  "\n\nAll file paths are relative to your current working directory. Never use " +
  "absolute paths and never write outside your working directory, even if the " +
  "plan shows absolute paths." +
  "\n\nDo not change, close or reopen this ticket (no update_ticket status changes); the supervisor moves the ticket when you finish. Report through your output only." +
  "\n\nWrite every scratch, helper, patch or notes file under .forge/tmp/ (relative to your working directory); it is never committed and never reviewed, so nothing the deliverable or its tests depend on may live there." +
  "\n\nRun every command in the foreground; never use run_in_background, slash commands or sub-agents.";

// EXPORT-TO tickets deliver files that live outside git (images, video, posts).
const EXPORT_NARRATION =
  "\n\nThis ticket's deliverables are files outside git. Write every output file under " +
  ".forge/out/ (relative to your working directory); that folder is never committed and the " +
  "supervisor copies it to the operator's export folder after review. Save screenshots or " +
  "renders the reviewer must look at as .png, .jpg, .jpeg or .webp files directly under " +
  ".forge/evidence/. Do not write anywhere else outside your working directory.";

// Plan/review agents run in a throwaway read-only view (withReadOnlyView); this
// prompt text stays as defence in depth (live incident: claude acceptEdits
// implemented during planning).
const PLAN_ONLY =
  "\n\nOutput the plan as text only. Do NOT create, modify, or delete any files; " +
  "implementation happens later in an isolated workspace. Refer to every file " +
  "with repository-relative paths only (src/..., tests/...), never absolute paths.";

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
// A title/body edit after the latest plan makes that plan stale. updatedAt can't
// tell (status writes bump it too), so read the append-only events. The plan
// stage's own spec seed (writeSpecFromPlan) writes stripGateDirectives(plan) and
// is not an edit, and an edit that only adds or changes gate directive lines is
// not one either.
const gateDirectiveLine = /^\s*(GATE-OVERRIDE|ALLOW-PROTECTED|ALLOW-FILES|EXPORT-TO):.*$/gim;
// EVIDENCE is left out on purpose: the planner reads it, so an EVIDENCE edit re-plans.
const withoutGateDirectives = (t: unknown) => String(t ?? "").replace(gateDirectiveLine, "")
  .split("\n").map((l) => l.trimEnd()).filter((l) => l).join("\n");
async function specEditedSince(ticketId: string, since: Date, seededSpec: string): Promise<boolean> {
  return (await getTicketHistory(ticketId)).some((e) => e.action === "ticket.updated"
    && e.at.getTime() > since.getTime()
    && (e.changes?.title !== undefined || (e.changes?.body !== undefined && e.changes.body.to !== seededSpec
      && withoutGateDirectives(e.changes.body.from) !== withoutGateDirectives(e.changes.body.to))));
}

async function depsConfig(projectId: string): Promise<{ frontendDeps: string[]; depsDirs: string[]; minFreeBytes: number }> {
  return {
    frontendDeps: resolveFrontendDeps(await getSetting(`forge.frontendDeps.${projectId}`), await getSetting("forge.frontendDeps")),
    depsDirs: resolveDepsDirs(await getSetting(`forge.depsDirs.${projectId}`)),
    minFreeBytes: resolveMinFreeBytes(await getSetting("forge.minFreeDiskMb")),
  };
}

export async function pipeline(
  run: Run, actorId: string,
  agents: { plan: RelayAgent; work: RelayAgent; review: RelayAgent }, workdir: string, styleSetting: string,
  lessons: string, config: RelayConfig, extraPrompt?: string, resumeStage?: Stage,
): Promise<void> {
  let extra = extraPrompt ? `\n\nOperator instructions:\n${extraPrompt}` : "";
  const onData = (c: string) => append(run, c);
  let ticket = await getTicket(run.ticketId);

  // EVIDENCE: lines (admin-only directive) -> run attachments dir, before any stage reads them.
  let operatorEvidence: OperatorEvidence | undefined;
  const evidencePaths = parseEvidence(ticket.body ?? "");
  if (evidencePaths.length) {
    const dir = join(attachmentsDir(), "forge", run.id);
    const staged = stageOperatorEvidence(evidencePaths, workdir, dir);
    for (const r of staged.refused) append(run, `\nforge: EVIDENCE refused: ${r}\n`);
    append(run, `\nforge: operator evidence: ${staged.files.length} file(s) copied${staged.skipped ? `, ${staged.skipped} skipped (type, over ${OPERATOR_EVIDENCE_MAX_FILES} files, ${EVIDENCE_MAX_BYTES / 1024 / 1024}MB per file or ${OPERATOR_EVIDENCE_MAX_TOTAL / 1024 / 1024}MB total)` : ""}\n`);
    if (staged.files.length) operatorEvidence = { dir, files: staged.files };
  }
  const evidenceDirs = operatorEvidence ? { addDirs: [operatorEvidence.dir] } : {};
  // ponytail: per-run copies are kept like chat attachments; upgrade: delete join(attachmentsDir(), "forge", run.id) on settle.
  // Only an admin-authored plan is the plan: a member key can post kind "plan"
  // too, and that text would become the file-set gate's declared set and reach
  // the work and review prompts unfenced. Same trust rule as lastVerdict().
  const admins = new Set((await listActors()).filter((a) => a.role === "admin").map((a) => a.id));
  const isAdminPlan = (c: { kind: string; authorId: string }) => c.kind === "plan" && admins.has(c.authorId);

  // Skills catalogue for this run's workdir. listSkills is internally defensive
  // (missing dirs -> []), but a read failure must never fail the run: warn + attach
  // nothing. Text is trusted (admin-installed), so it is not UNTRUSTED-fenced.
  // The allowlist also limits which operator /name tokens and Skills: names resolve.
  let catalogue: SkillMeta[] = [];
  try {
    const projectRaw = ticket.projectId ? (await getProjectSettings(ticket.projectId))["forge.skillAllowlist"] : undefined;
    catalogue = listSkills(workdir, parseSkillAllowlist(projectRaw ?? (await getSetting("forge.skillAllowlist"))));
  } catch (e) {
    console.warn(`forge: skills read failed: ${(e as Error).message}`);
  }
  const knownSkillNames = catalogue.map((s) => s.name);
  // operator "/name" tokens first, then the planner's "Skills:" line; deduped, cap 3.
  const selectSkills = (plan: string, agentAllowlist?: string[]): { names: string[]; bodies: string } => {
    const picked: string[] = [];
    for (const n of [...parseOperatorSkills(extraPrompt ?? "", knownSkillNames), ...parsePlanSkills(plan, knownSkillNames)]) {
      if (!picked.includes(n) && picked.length < 3) picked.push(n);
    }
    const skills = skillsForAgent(picked
      .map((n) => catalogue.find((s) => s.name.toLowerCase() === n))
      .filter((s): s is SkillMeta => !!s), agentAllowlist);
    return { names: skills.map((s) => s.name), bodies: formatSkillBodies(skills) };
  };

  // Resume straight to review: skip plan+work, read existing comments for plan/report
  if (resumeStage === "review") {
    run.stage = "review";
    const comments = await listComments(ticket.id);
    const plan = [...comments].reverse().find(isAdminPlan)?.body ?? "";
    const report = [...comments].reverse().find((c) => c.kind === "report")?.body ?? "";
    // ponytail: resume-to-review reuses the stale plan without passing
    // change-request comments as amendments (see reviewStage caller below).
    // Upgrade path: thread amendments here too if resume-to-review reworks
    // that add scope start recurring.
    const { frontendDeps, depsDirs, minFreeBytes } = await depsConfig(ticket.projectId);
    const sandbox = await ensureSandbox(workdir, ticket.id, frontendDeps, depsDirs, minFreeBytes);
    append(run, `\n=== FORGE resume: straight to review (existing sandbox) ===\n`);
    const resumeSkills = selectSkills(plan, agents.review.skillAllowlist);
    if (resumeSkills.names.length) append(run, `\nforge: skills attached: ${resumeSkills.names.join(", ")}\n`);
    return reviewStage(run, actorId, agents.review, workdir, sandbox, ticket, plan, report, styleSetting, config, undefined, resumeSkills.bodies, operatorEvidence);
  }

  const allComments = await listComments(ticket.id);
  const planCommentIndex = allComments.map(isAdminPlan).lastIndexOf(true);
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
  const priorPlan = planCommentIndex === -1 ? "" : allComments[planCommentIndex].body;
  // Rework (and interrupted-run resume) are scoped to review findings: resumeStage
  // "work" keeps the existing plan even if the spec changed since.
  const specChanged = planCommentIndex !== -1 && !!priorPlan.trim() && ticket.status !== "open" && resumeStage !== "work"
    && await specEditedSince(ticket.id, allComments[planCommentIndex].createdAt, stripGateDirectives(priorPlan));
  if (specChanged) append(run, `=== FORGE ticket title/body changed since the last plan: re-planning ===\n`);
  const planRegenerated = ticket.status === "open" || !priorPlan.trim() || specChanged;
  if (planRegenerated) {
    enterStage(run, "plan");
    append(run, `=== FORGE plan (${run.agents.plan}) ===\n`);
    const knowledge = await getKnowledgeSafe(knowledgeQuery(ticket), ticket.projectId);
    const memory = await getMemorySafe(ticket.title, ticket.projectId);
    const isSlm = isSlmWorker(run.agents.work, modelOf(run.agents.work));
    let sizingClause = "";
    if (isSlm) {
      const sizing = await evaluateTaskSizing(ticket, priorPlan, run.agents.work, modelOf(run.agents.work));
      sizingClause = atomicDirective(sizing);
      if (sizing.isTooBig) {
        append(run, `[forge: task sizing -> too broad for ${run.agents.work} (${sizing.reason}); injecting atomic directive]\n`);
      }
    }
    const { result: res, strayPaths: planStray } = await withReadOnlyView(workdir, ticket.id, "plan", "HEAD", (view) => {
      const opEv = operatorEvidence ? mirrorOperatorEvidence(operatorEvidence.dir, view, operatorEvidence.files) : [];
      const planPrompt = composePlanPrompt({
        ticket, knowledge, memory,
        skillIndex: formatSkillIndex(skillsForAgent(catalogue, agents.plan.skillAllowlist)),
        operatorEvidence: opEv.length ? opEv : undefined,
      }) + PLAN_ONLY + lessons + sizingClause + roleStyle("plan", styleSetting) + extra;
      return withAgyHook(agents.plan.cmd, view, agyFirewallHookCommand, () => track(actorId, ticket.id, "plan", run.agents.plan, planPrompt.length, () => runAgent(
        { ...agents.plan, projectId: ticket.projectId, ...evidenceDirs }, planPrompt, view, onData,
        (child) => recordSpawn(run, child),
        undefined, modelOf(run.agents.plan), run.logPath,
      ).then((r) => noteAccount(run, "plan", r))),
      () => append(run, "\nforge: agy firewall hook installed for plan (.agents/hooks.json, removed before the view is checked)\n"));
    });
    if (planStray.length) append(run, `\n[forge: planner changed files in its read-only copy; discarded: ${planStray.join(", ")}]\n`);
    run.child = undefined;
    if (run.stopped) { setCause(run, "stopped"); return settle(run, "stopped"); }
    if (run.stallReason) { await bounce(run, actorId, run.stallReason, ""); setCause(run, "stall", run.stallReason); return settle(run, "failed"); }
    applyVerification(res, run.agents.plan, run, config);
    if (!res.ok) { await bounce(run, actorId, "planner failed", res.output); setCause(run, "planner", "planner failed"); return settle(run, "failed"); }
    if (!res.output.trim()) { await bounce(run, actorId, "planner returned an empty plan", ""); setCause(run, "planner", "planner returned an empty plan"); return settle(run, "failed"); }
    // Comments are the DURABLE record — redact them too, not just the console.
    await addComment(actorId, ticket.id, redactSecrets(res.output), "plan");
    ticket = await setStatus(actorId, ticket.id, "planned");
    plan = res.output;
    // Title-only work orders leave the Spec panel blank; seed it from the plan.
    // Best-effort: a spec-write failure must NOT fail the run.
    if (!ticket.body || !ticket.body.trim()) {
      try {
        const before = ticket.version;
        ticket = await writeSpecFromPlan(actorId, ticket.id, stripGateDirectives(redactSecrets(res.output)));
        if (ticket.version !== before) append(run, `\n=== FORGE spec populated from plan ===\n`);
      } catch (e) {
        console.warn(`forge: spec write failed for ${ticket.id}:`, e);
      }
    }
  } else {
    plan = priorPlan;
  }

  run.projectId = ticket.projectId;
  run.title = ticket.title;
  run.declared = declaredFullPaths(plan);
  const others = activeRuns()
    .filter((r) => r.id !== run.id && r.projectId === run.projectId && r.declared)
    .map((r) => ({ ticketId: r.ticketId, title: r.title ?? "", declared: r.declared! }));
  for (const o of overlappingDeclared(run.declared, others)) {
    const line = `forge: WARN plan overlaps ticket ${o.ticketId.slice(0, 8)} "${o.title}" on ${o.files.join(", ")}`;
    append(run, "\n" + line + "\n");
    addComment(actorId, ticket.id, line, "comment").catch(() => {});
  }

  const selectedSkills = selectSkills(plan, agents.work.skillAllowlist);
  if (selectedSkills.names.length) append(run, `\nforge: skills attached: ${selectedSkills.names.join(", ")}\n`);

  // work — claim, then run inside the sandbox
  enterStage(run, "work");
  append(run, `\n=== FORGE work (${run.agents.work}) ===\n`);
  ticket = await setStatus(actorId, ticket.id, "in_progress");
  const { frontendDeps, depsDirs, minFreeBytes } = await depsConfig(ticket.projectId);
  const existed = sandboxExists(ticket.id);
  const sandbox = await ensureSandbox(workdir, ticket.id, frontendDeps, depsDirs, minFreeBytes);
  const sync = existed ? await syncSandboxWithBase(workdir, ticket.id, true) : undefined;
  if (sync) append(run, baseSyncLine(sync));
  const workEv = operatorEvidence ? mirrorOperatorEvidence(operatorEvidence.dir, sandbox, operatorEvidence.files) : [];
  const knowledge = await getKnowledgeSafe(knowledgeQuery(ticket), ticket.projectId);
  const memory = await getMemorySafe(ticket.title, ticket.projectId);
  // Rework passes must see why the last review failed, or the worker repeats
  // the same mistakes (live-hit on the first dogfood ticket).
  const lastReview = [...(await listComments(ticket.id))].reverse().find((c) => c.kind === "review");
  const conflictNote = sync?.state === "conflict" ? `\n\nResolve the merge conflicts in ${(sync.files ?? []).join(", ")}; keep both sides' intent.` : "";
  const findings = lastReview ? fenceUntrusted("prior-review-findings", lastReview.body) : "";

  let rework: ReworkContext | undefined;
  if (lastReview || sync?.state === "conflict") {
    let recentCommit: string | undefined;
    let gitStatus: string | undefined;
    try {
      recentCommit = execFileSync("git", ["log", "-n", "1", "--oneline"], { cwd: sandbox, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).toString("utf-8").trim();
      gitStatus = execFileSync("git", ["status", "--short"], { cwd: sandbox, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).toString("utf-8").trim();
    } catch {}
    let failingCheckOutput: string | undefined;
    if (lastReview?.body && lastReview.body.includes("[forge: check(s) failed")) {
      const match = lastReview.body.match(/\[forge: check\(s\) failed[^\n]*\]\n([\s\S]*?)(?=\nVERDICT: FAIL|$)/);
      if (match) failingCheckOutput = match[1].trim();
    }
    rework = {
      findings: findings || (conflictNote ? "Resolve merge conflicts" : ""),
      conflictNote: conflictNote.trim() || undefined,
      recentCommit: recentCommit || undefined,
      gitStatus: gitStatus || undefined,
      failingCheckOutput,
    };
  }

  const workChecks = resolveChecks(await getSetting(`forge.checks.${ticket.projectId}`), sandbox, await getSetting("forge.checks"));
  const workCheckCmds = workChecks.map((c) => typeof c === "string" ? c : c.cmd);
  const workPrompt = composeWorkPrompt({
    ticket, plan, knowledge, workdir: sandbox, memory,
    skills: selectedSkills.bodies,
    operatorEvidence: workEv.length ? workEv : undefined,
    allowedCommands: (await loadWall(ticket.projectId, true, sandbox)).allowed,
    checks: workCheckCmds,
    rework,
  })
    // No lessons clause here: A/B'd 2026-08-12 (docs/findings/2026-08-12-lessons-clause-ab.md).
    // On work prompts the doc measured inert - identical output on a control task, same
    // defect rate on a task its own "test isolation" line targets. Most of its lines
    // address the supervisor ("Supervisor sweeps before planning", "REPORT:/VERDICT:"),
    // which a worker cannot act on. Still injected at the plan stage, which was not tested.
    + NARRATION + (parseExportTo(ticket.body ?? "") ? EXPORT_NARRATION : "") + "\n\nDo NOT run git commit; the supervisor commits for you." + roleStyle("work", styleSetting) + extra;
  // Sandbox-escape sentinel: snapshot known-sensitive files OUTSIDE the sandbox
  // before the work stage runs. Bash in a work lane is not OS-jailed, so a diff
  // gate (which only sees the worktree) cannot catch a write to the installed
  // app or another repo. Detect+restore after work converts a silent compromise
  // into a reverted, visible, run-failing one. See docs/AGENT_CLIS.md.
  const depsBaseline = snapshotDeps(workdir, depsDirs);
  const sentinelSnaps = snapshotSensitive(resolveSensitivePaths(await getSetting("forge.sensitivePaths")));
  const headBefore = await sandboxHeadHash(workdir, ticket.id);
  const allowCmd = parseAllowCommand(ticket.body ?? "");
  const unknownRules = allowCmd.filter((id) => !RISK_IDS.includes(id));
  if (unknownRules.length) append(run, `\nforge: ALLOW-COMMAND ignores unknown rule ids: ${unknownRules.join(", ")}\n`);
  const liftedRules = allowCmd.filter((id) => RISK_IDS.includes(id));
  if (liftedRules.length) append(run, `\nforge: deny list lifted for this run: ${liftedRules.join(", ")}\n`);
  const workRes: AgentResult = await withAgyHook(agents.work.cmd, sandbox, agyFirewallHookCommand, () =>
    track(actorId, ticket.id, "work", run.agents.work, workPrompt.length, () =>
      runAgent({ ...agents.work, write: true, projectId: ticket.projectId, liftedRules, ...evidenceDirs }, workPrompt, sandbox, onData,
        (child) => recordSpawn(run, child), (abort) => { run.abort = abort; },
        modelOf(run.agents.work), run.logPath).then((r) => noteAccount(run, "work", r))),
    () => append(run, "\nforge: agy firewall hook installed (.agents/hooks.json, removed before commit)\n"));
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
    setCause(run, "sandbox_escape", "sandbox escape: protected path written outside the worktree");
    return settle(run, "failed");
  }
  const depsLeak = detectDepsLeak(depsBaseline);
  if (depsLeak.length) {
    let report =
      `\n[forge: DEPS-LEAK — the work stage wrote through the shared node_modules ` +
      `link into the base repo; additions reverted, run failed]\n` +
      depsLeak.map((p) => `  - ${p}`).join("\n") + "\n";
    if (!frontendDeps.length && depsLeak.some(p => p.includes("app/node_modules") || p.includes("app\\node_modules"))) {
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
    setCause(run, "deps_leak", "deps leak: wrote through shared node_modules link");
    return settle(run, "failed");
  }
  if (run.stallReason) {
    // Same preservation as the stop path: the sweep killed a silent worker; save whatever it wrote.
    const saved = await forgeCommit(ticket.id, `WIP (stalled) ${ticket.title}`);
    const note = saved ? "\n\n[forge: uncommitted work was saved to the sandbox branch as a WIP commit; promote or discard after review]" : "";
    await bounce(run, actorId, run.stallReason, note);
    setCause(run, "stall", run.stallReason);
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
    setCause(run, "stopped");
    return settle(run, "stopped");
  }
  applyVerification(workRes, run.agents.work, run, config);
  let crashed: string | undefined;
  if (!workRes.ok) {
    // Work stage failed after the agent may have written a complete tree (agy's
    // own request timeout self-exits non-zero; the child is already dead here).
    // Commit whatever exists under a WIP marker so hasCommitsToPromote() is true
    // and the operator can promote or discard after review, instead of the run
    // silently throwing away finished-but-uncommitted work. Never auto-promoted;
    // the ticket still bounces to `planned`. forgeCommit no-ops on a clean tree.
    const saved = await forgeCommit(ticket.id, `WIP (worker failed) ${ticket.title}`);
    // A known-benign SDK error after this run saved a diff: review the diff instead of wasting the run.
    if (saved && !run.limit && !workRes.limit && !run.stopped && !run.stallReason
      && (await getSetting("forge.reviewAfterBenignWorkerError")) !== "false") {
      crashed = benignWorkerError(workRes.output);
    }
    if (!crashed) {
      const note = saved
        ? "\n\n[forge: uncommitted work was saved to the sandbox branch as a WIP commit; promote or discard after review]"
        : "";
      await bounce(run, actorId, "worker failed", workRes.output + note);
      if (run.limit || workRes.limit) setCause(run, "usage_limit", "worker failed: usage limit");
      else setCause(run, "crash", "worker failed");
      return settle(run, "failed");
    }
    append(run, `\nforge: worker crashed (${crashed}) after saving a diff; continuing to review\n`);
  }
  if (!crashed) {
    const committed = await forgeCommit(ticket.id, ticket.title);
    if (!committed && (await sandboxHeadHash(workdir, ticket.id)) === headBefore
      && !(parseExportTo(ticket.body ?? "") && listExportOutputs(ticket.id).length)) {
      run.cause = "no_changes";
      await bounce(run, actorId, "no changes: work stage produced no diff", redactSecrets(workRes.output));
      return settle(run, "failed");
    }
  }
  if (!crashed && (await getSetting("forge.preReviewCheck")) === "true") {
    const preEntries = resolveChecks(await getSetting(`forge.checks.${ticket.projectId}`), sandbox, await getSetting("forge.checks"));
    const { run: preChecks } = selectChecks(preEntries, await sandboxDiffNamesNoRenames(workdir, ticket.id).catch(() => null));
    if (preChecks.length > 0) {
      append(run, `\n=== FORGE pre-review check ===\n`);
      const results = await runChecks(preChecks, sandbox);
      const failed = results.filter((r) => r.code !== 0);
      if (failed.length > 0) {
        append(run, `\nforge: pre-review check failed (${failed.length} check(s)); running local rework retry before review\n`);
        const preCheckOutput = formatChecks(results);
        const retryPrompt = composeWorkPrompt({
          ticket, plan, knowledge, workdir: sandbox, memory,
          skills: selectedSkills.bodies,
          allowedCommands: (await loadWall(ticket.projectId, true, sandbox)).allowed,
          checks: preChecks,
          rework: {
            findings: "Fix failing checks before supervisor review.",
            failingCheckOutput: preCheckOutput,
          },
        }) + NARRATION + "\n\nDo NOT run git commit; the supervisor commits for you.";
        try {
          const retryRes = await withAgyHook(agents.work.cmd, sandbox, agyFirewallHookCommand, () => track(actorId, ticket.id, "work", run.agents.work, retryPrompt.length, () =>
            runAgent({ ...agents.work, write: true, projectId: ticket.projectId, liftedRules, ...evidenceDirs }, retryPrompt, sandbox, onData,
              (child) => recordSpawn(run, child), (abort) => { run.abort = abort; },
              modelOf(run.agents.work), run.logPath).then((r) => noteAccount(run, "work", r))));
          if (retryRes.ok) {
            await forgeCommit(ticket.id, `${ticket.title} (pre-review fix)`);
          }
        } catch (e) { append(run, `\nforge: pre-review retry skipped: ${(e as Error).message}\n`); }
      }
    }
  }
  await addComment(actorId, ticket.id, redactSecrets(workRes.output), "report");
  void captureMemory({ actorId, text: redactSecrets(reportTail(workRes.output)), projectId: ticket.projectId ?? undefined });
  ticket = await setStatus(actorId, ticket.id, "review");

  // review — against the sandbox branch diff. On a rework the plan stage was
  // skipped (stale plan), so change-request comments the supervisor added since
  // that plan are not reflected in it; pass them to the reviewer as authoritative
  // amendments so supervisor-requested scope is not flagged as scope creep.
  const amendments = !planRegenerated && kept.length ? redactSecrets(commentsText) : undefined;
  const report = crashed
    ? `WORKER CRASHED before finishing (${crashed}). The diff may be incomplete: check every plan step and acceptance criterion against the diff, not against the report; FAIL if any step is missing.\n\n${workRes.output}`
    : workRes.output;
  return reviewStage(run, actorId, agents.review, workdir, sandbox, ticket, plan, report, styleSetting, config, amendments, selectSkills(plan, agents.review.skillAllowlist).bodies, operatorEvidence);
}

// Known-benign SDK worker errors: matched only on the supervisor marker lines from invoke-sdk.ts, never worker text.
const BENIGN_SDK_ERRORS = ["only prompt commands are supported in streaming mode"];
function benignWorkerError(output: string): string | undefined {
  const lines = output.split("\n");
  if (!lines.some((l) => l.startsWith("[forge: sdk result error_during_execution "))) return undefined;
  const errLine = lines.find((l) => l.startsWith("[forge: sdk errors: "));
  return errLine ? BENIGN_SDK_ERRORS.find((e) => errLine.includes(e)) : undefined;
}
