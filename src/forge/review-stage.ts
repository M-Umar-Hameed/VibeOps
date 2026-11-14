import { existsSync } from "node:fs";
import { type RelayConfig, type RelayAgent } from "../relay/config.js";
import { roleStyle } from "../relay/style.js";
import { composeReviewPrompt, parseReason } from "../relay/prompts.js";
import { agyFirewallHookCommand } from "../relay/wall.js";
import { withAgyHook } from "./agy-hook.js";
import { chunkReviewDiff, mergeReviewVerdicts } from "./review-chunks.js";
import { killTree, type AgentResult } from "../relay/invoke.js";
import { runAgent } from "../relay/dispatch.js";
import { redactSecrets } from "./redact.js";
import { sandboxDiff, sandboxDiffSummary, sandboxDiffNames, sandboxDiffNamesNoRenames, sandboxRangePatch, withReadOnlyView, branchName, copyEvidence, listExportOutputs, attachmentsDir, EVIDENCE_MAX_FILES, EVIDENCE_MAX_BYTES, mirrorOperatorEvidence, syncSandboxWithBase, type BaseSync, conflictMarkerFiles, duplicateAddedTestTitles } from "./sandbox.js";
import { resolveProtectedPaths, parseAllowProtected, evaluateProtectedPaths, parseExportTo } from "./policy.js";
import { addComment } from "../services/comments.js";
import { getSetting } from "../services/settings.js";
import { desc, eq, and, ne } from "drizzle-orm";
import { db } from "../db/client.js";
import { forgeRuns, type Ticket } from "../db/schema.js";
import { resolveChecks, runChecks, formatChecks, selectChecks, CHECK_TIMEOUT_MS, type CheckResult } from "./checks.js";
import { runGate, resolveMutationCmd } from "./gate.js";
import { type Run, append, enterStage, recordSpawn, setCause, settle, bounce, setStatus } from "./run-state.js";
import { track, noteAccount, modelOf, applyVerification } from "./run-agents.js";
import { getMemorySafe } from "./run-knowledge.js";

export function resolveMaxConcurrentChecks(setting: string | null): number {
  const n = parseInt(setting ?? "", 10);
  return Number.isInteger(n) && n >= 1 ? n : Infinity;
}
let checkSlotsHeld = 0;
const checkSlotQueue: Run[] = [];
const CHECK_SLOT_POLL_MS = 500;

async function acquireCheckSlot(run: Run): Promise<boolean> {
  checkSlotQueue.push(run);
  let lastAhead = -1;
  try {
    for (;;) {
      if (run.stopped || run.stallReason) return false;
      const max = resolveMaxConcurrentChecks(await getSetting("forge.maxConcurrentChecks"));
      const pos = checkSlotQueue.indexOf(run);
      if (pos === 0 && checkSlotsHeld < max) { checkSlotsHeld++; return true; }
      run.lastActivityAt = Date.now();
      const ahead = checkSlotsHeld + pos;
      if (ahead !== lastAhead) { append(run, `\nforge: waiting for a check slot (${ahead} ahead)\n`); lastAhead = ahead; }
      await new Promise((r) => setTimeout(r, CHECK_SLOT_POLL_MS));
    }
  } finally {
    checkSlotQueue.splice(checkSlotQueue.indexOf(run), 1);
  }
}
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

export const BASE_CONFLICT = "[forge: base conflict]";
const CONFLICT_MARKERS = "[forge: conflict markers]";
const DUPLICATE_TESTS = "[forge: duplicate tests]";

export function baseSyncLine(s: BaseSync): string {
  return `\n=== FORGE base sync: ${s.state}${s.files?.length ? ` (${s.files.join(", ")})` : ""} ===\n`;
}

export type OperatorEvidence = { dir: string; files: string[] };

async function previousRunTimedOut(run: Run): Promise<boolean> {
  const [row] = await db.select({ cause: forgeRuns.cause }).from(forgeRuns)
    .where(and(eq(forgeRuns.ticketId, run.ticketId), ne(forgeRuns.id, run.id)))
    .orderBy(desc(forgeRuns.startedAt)).limit(1);
  return row?.cause === "check_timeout";
}

const CHECK_TIMEOUT_MIN_MS = 60_000;
const CHECK_TIMEOUT_MAX_MS = 3_600_000;
function resolveCheckTimeoutMs(...settings: (string | null)[]): number {
  for (const s of settings) {
    const n = s === null ? NaN : Number(s.trim());
    if (Number.isInteger(n) && n > 0) return Math.min(CHECK_TIMEOUT_MAX_MS, Math.max(CHECK_TIMEOUT_MIN_MS, n));
  }
  return CHECK_TIMEOUT_MS;
}

// Extracted for resume-to-review: runs the review stage against an existing sandbox.
export async function reviewStage(
  run: Run, actorId: string, reviewAgent: RelayAgent, workdir: string,
  sandbox: string, ticket: Ticket, plan: string, reportOutput: string,
  styleSetting: string, config: RelayConfig, amendments?: string, skills?: string,
  operatorEvidence?: OperatorEvidence,
): Promise<void> {
  enterStage(run, "review");
  append(run, `\n=== FORGE review (${run.agents.review}) ===\n`);
  const onData = (c: string) => append(run, c);

  if (run.stopped) { setCause(run, "stopped"); return settle(run, "stopped"); }

  const sync = await syncSandboxWithBase(workdir, ticket.id);
  append(run, baseSyncLine(sync));
  if (sync.state === "conflict") {
    const files = sync.files ?? [];
    await addComment(actorId, ticket.id,
      `${BASE_CONFLICT} ${branchName(ticket.id)} conflicts with the base ${sync.base.slice(0, 12)} in ${files.length} file(s):\n` +
      `${files.map((f) => `  - ${f}`).join("\n")}\n` +
      `Resolve the merge conflicts in ${files.join(", ")}; keep both sides' intent.\nVERDICT: FAIL`, "review");
    await setStatus(actorId, ticket.id, "planned");
    setCause(run, "base_conflict", "base conflict");
    return settle(run, "rejected");
  }
  const guardDiff = await sandboxDiff(workdir, ticket.id);
  const markers = conflictMarkerFiles(guardDiff);
  if (markers.length) {
    await addComment(actorId, ticket.id,
      `${CONFLICT_MARKERS} ${branchName(ticket.id)} adds unresolved merge conflict markers in ${markers.length} file(s):\n` +
      `${markers.map((f) => `  - ${f}`).join("\n")}\n` +
      `Remove every <<<<<<< / ======= / >>>>>>> block in ${markers.join(", ")}; keep both sides' intent.\nVERDICT: FAIL`, "review");
    await setStatus(actorId, ticket.id, "planned");
    setCause(run, "conflict_markers", "conflict markers");
    return settle(run, "rejected");
  }
  const dupes = duplicateAddedTestTitles(guardDiff);
  if (dupes.length) {
    await addComment(actorId, ticket.id,
      `${DUPLICATE_TESTS} ${branchName(ticket.id)} adds the same test title more than once:\n` +
      `${dupes.map((d) => `  - ${d}`).join("\n")}\n` +
      `Keep one copy of each test and delete the repeated block.\nVERDICT: FAIL`, "review");
    await setStatus(actorId, ticket.id, "planned");
    setCause(run, "duplicate_tests", "duplicate tests");
    return settle(run, "rejected");
  }

  // Checks: project static gates run in the SANDBOX (T17 shipped a tsc break —
  // reviewer reads diffs, vitest transpiles without typechecking). Resolved
  // here but not RUN yet: they execute concurrently with the review agent
  // below (once the diff is settled), so a slow check no longer serializes
  // in front of the reviewer's read time. A failing check force-fails the
  // run mechanically at verdict time, independent of the reviewer's own
  // verdict — see the gate evaluation below.
  const checkEntries = resolveChecks(await getSetting(`forge.checks.${ticket.projectId}`), sandbox, await getSetting("forge.checks"));
  const checkTimeoutMs = resolveCheckTimeoutMs(await getSetting(`forge.checkTimeoutMs.${ticket.projectId}`), await getSetting("forge.checkTimeoutMs"));

  // Protected-path policy: deterministic, evaluated on the diff (never the
  // worker's self-report). A touched protected path is an automatic Critical
  // finding that force-fails the review below and blocks promote, unless the
  // ticket body waives it with an ALLOW-PROTECTED: <glob>,<glob> line.
  const protectedGlobs = resolveProtectedPaths(await getSetting("forge.protectedPaths"));
  const allowGlobs = parseAllowProtected(ticket.body ?? "");
  const changedPaths = await sandboxDiffNames(workdir, ticket.id);
  const violations = evaluateProtectedPaths(changedPaths, protectedGlobs, allowGlobs);
  run.protectedViolations = violations.length ? violations : undefined;

  const { run: checkCmds, skipped: skippedChecks } = selectChecks(checkEntries, await sandboxDiffNamesNoRenames(workdir, ticket.id).catch(() => null));
  const skippedText = skippedChecks.map((s) => `$ ${s.cmd}\nskipped (no changed path matches ${s.paths.join(", ")})`).join("\n\n");
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

  if (run.stopped) { setCause(run, "stopped"); return settle(run, "stopped"); }

  const [diff, stat] = await Promise.all([
    sandboxDiff(workdir, ticket.id),
    sandboxDiffSummary(workdir, ticket.id),
  ]);
  // S6: under the cap this is one chunk (the elided diff verbatim -- single-
  // invocation path unchanged). Over the cap, one chunk per directory group,
  // each carrying the whole-diff stat so the reviewer knows what it cannot see.
  const chunks = chunkReviewDiff(elideGeneratedDiffs(diff), stat, DIFF_PROMPT_CAP);

  if (run.stopped) { setCause(run, "stopped"); return settle(run, "stopped"); }

  // Checks run BEFORE the review so the reviewer judges real results, not the diff alone.
  let checkResults: CheckResult[] = [];
  if (checkCmds.length) {
    if (await acquireCheckSlot(run)) {
      try {
        run.checksStartedAt = Date.now();
        checkResults = await runChecks(checkCmds, sandbox, checkTimeoutMs, (child) => {
          run.checksChild = child;
          if (run.stopped) void killTree(child);
        });
        run.checksChild = undefined;
        run.checksEndedAt = Date.now();
      } finally {
        checkSlotsHeld--;
      }
    }
  }
  if (run.checksStartedAt !== undefined) run.checksDurationMs = Date.now() - run.checksStartedAt;
  if (run.stopped) { setCause(run, "stopped"); return settle(run, "stopped"); }
  if (run.stallReason) { await bounce(run, actorId, run.stallReason, ""); setCause(run, "stall", run.stallReason); return settle(run, "failed"); }

  let checksText: string | undefined;
  let checksFailed = false;
  if (checkCmds.length) {
    checksText = redactSecrets(formatChecks(checkResults));
    checksFailed = checkResults.some((r) => r.code !== 0);
  }
  const checksLog = [checksText, skippedText].filter(Boolean).join("\n\n");
  if (checksLog) append(run, `\n=== FORGE checks ===\n${checksLog}\n`);

  // One review invocation per chunk, sequential: recordSpawn tracks a single
  // live child/pid, and chunked review is the rare oversized-diff path.
  run.reviewStartedAt = Date.now();
  const outputs = parseExportTo(ticket.body ?? "") ? listExportOutputs(ticket.id) : undefined;
  const reviewer = {
    ...reviewAgent,
    projectId: ticket.projectId,
    ...(existsSync(attachmentsDir()) ? { addDirs: [attachmentsDir()] } : {}),
  };
  const memory = await getMemorySafe(ticket.title, ticket.projectId);
  const { result: reviewResults, strayPaths: reviewStray } = await withReadOnlyView(workdir, ticket.id, "review", branchName(ticket.id), async (view) => {
    const evidence = copyEvidence(sandbox, view);
    if (evidence.paths.length || evidence.skipped) {
      append(run, `\nforge: evidence images for review: ${evidence.paths.length}${evidence.skipped ? `, ${evidence.skipped} skipped (over ${EVIDENCE_MAX_FILES} files or ${EVIDENCE_MAX_BYTES / 1024 / 1024}MB)` : ""}\n`);
    }
    const opEv = operatorEvidence ? mirrorOperatorEvidence(operatorEvidence.dir, view, operatorEvidence.files) : [];
    const results: AgentResult[] = [];
    for (const chunk of chunks) {
      if (run.stopped || run.stallReason) break;
      const reviewPrompt = composeReviewPrompt({
        ticket, plan, report: reportOutput, diff: chunk.payload, operatorNotes: run.operatorNotes,
        checks: checksText, checksFailed,
        protectedViolation: protectedFinding, amendments, gate: gate.report || undefined,
        citations: gate.citations || undefined, skills,
        evidence: evidence.paths.length ? evidence.paths : undefined,
        outputs,
        memory: memory || undefined,
        operatorEvidence: opEv.length ? opEv : undefined,
      }) + roleStyle("review", styleSetting);
      results.push(await withAgyHook(reviewer.cmd ?? [], view, agyFirewallHookCommand, () => track(actorId, ticket.id, "review", run.agents.review, reviewPrompt.length, () => runAgent(
        reviewer,
        reviewPrompt,
        view, onData,
        (child) => recordSpawn(run, child),
        undefined, modelOf(run.agents.review), run.logPath,
      ).then((r) => noteAccount(run, "review", r)))));
    }
    return results;
  });
  run.child = undefined;
  if (run.stopped) { setCause(run, "stopped"); return settle(run, "stopped"); }
  if (run.stallReason) { await bounce(run, actorId, run.stallReason, ""); setCause(run, "stall", run.stallReason); return settle(run, "failed"); }

  // A reviewer that never produced a verdict (non-zero exit, thrown error, an
  // API/transport error surfaced in output, or empty output) is "could not be reached", NOT
  // "judged and said no". Settle `failed` (the infra-trouble status) so recovery
  // offers resume-to-review against the existing work commit, instead of
  // `rejected` — which routes to rework and needlessly re-runs the whole work
  // stage over code that was already complete and verified.
  const reviewFailure = reviewResults.find((r) => !r.ok || !r.output.trim());
  if (reviewFailure) {
    await bounce(run, actorId, "reviewer failed", reviewFailure.output);
    setCause(run, "reviewer_failed", "reviewer failed");
    return settle(run, "failed");
  }

  if (reviewStray.length) {
    await bounce(run, actorId, "reviewer changed files in its read-only copy", reviewStray.join("\n"));
    setCause(run, "reviewer_stray", "reviewer changed files in its read-only copy");
    return settle(run, "failed");
  }

  for (const res of reviewResults) applyVerification(res, run.agents.review, run, config);
  const verdict = mergeReviewVerdicts(chunks, reviewResults.map((r) => r.output));

  const failedChecks = checkResults.filter((r) => r.code !== 0);
  const checksTimedOutOnly = checksFailed && failedChecks.every((r) => r.timedOut);
  if (verdict.pass && !gateBlocked && checksTimedOutOnly && !(await previousRunTimedOut(run))) {
    const timedOutCmds = failedChecks.map((r) => r.command).join(", ");
    await addComment(actorId, ticket.id, redactSecrets(`${verdict.raw}\n\n[forge: check(s) timed out (infra) - verdict forced to FAIL]\n${checksText}\nVERDICT: FAIL`), "review");
    await bounce(run, actorId, `checks timed out: ${timedOutCmds}`, checksText ?? "");
    setCause(run, "check_timeout", `checks timed out: ${timedOutCmds}`);
    return settle(run, "failed");
  }

  // Gate block or a failing check forces FAIL regardless of the model's verdict.
  // The comment is the durable record (run output dies with the process), so it
  // carries the check results on every outcome: the full tail on a failure, one
  // command+exit line per check when they passed.
  const pass = verdict.pass && !gateBlocked && !checksFailed;
  const checksBlockNote = checksFailed
    ? `\n\n[forge: check(s) failed — verdict forced to FAIL]\n${checksText}\nVERDICT: FAIL`
    : "";
  const checksPassedNote = (checkCmds.length && !checksFailed)
    ? `\n\n[forge: checks passed]\n${checkResults.map((r) => `$ ${r.command}\nexit ${r.code}`).join("\n")}`
    : "";
  const checksSkippedNote = skippedChecks.length ? `\n\n[forge: checks skipped]\n${skippedText}` : "";
  const reviewBody = gateBlocked
    ? `${verdict.raw}${checksBlockNote}${checksPassedNote}${checksSkippedNote}\n\n[forge: mechanical gate BLOCK — verdict forced to FAIL]\n${gate.report}\nVERDICT: FAIL`
    : `${verdict.raw}${checksBlockNote}${checksPassedNote}${checksSkippedNote}`;
  await addComment(actorId, ticket.id, redactSecrets(reviewBody), "review");

  if (!pass) {
    // FAIL: back to planned; sandbox kept for the rework pass. The run settles
    // "rejected" (not "passed") so the quality signal reflects the verdict, not
    // pipeline completion.
    const firstFailed = checkResults.find((r) => r.code !== 0)?.command;
    const gateWhy = gate.findings.filter((f) => f.severity === "block").map((f) => f.detail).join("; ");
    if (gateBlocked || checksFailed) {
      const forcedBy = gateBlocked && checksFailed ? "gate and checks" : gateBlocked ? "gate" : "checks";
      const why = [gateBlocked ? `gate: ${gateWhy}` : "", checksFailed ? `check failed: ${firstFailed}` : ""].filter(Boolean).join("; ");
      setCause(run, gateBlocked ? "gate" : "checks", verdict.pass ? `reviewer passed; forced by ${forcedBy}; ${why}` : why);
    } else {
      setCause(run, "reviewer", parseReason(verdict.raw));
    }
    await setStatus(actorId, ticket.id, "planned");
    return settle(run, "rejected");
  }
  // PASS: ticket STAYS in review — promotion is a human action.
  settle(run, "passed");
}
