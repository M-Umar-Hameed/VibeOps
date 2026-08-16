// Mechanical review gate — deterministic checks that run before the review model.
// Block findings force VERDICT: FAIL regardless of the model's output.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findSecrets, redactSecrets } from "./redact.js";
import { matchAny, parseAllowFiles } from "./policy.js";
import { runChecks } from "./checks.js";
import {
  sandboxPath, sandboxRangePatch, sandboxDiffNameStatus, sandboxBaseCommit,
  sandboxCheckout, sandboxDeletePaths, sandboxDiffNames,
} from "./sandbox.js";

// --- Types ---

export type GateFinding = {
  check: "secret" | "file-set" | "mutation" | "ac-map" | "citation";
  severity: "block" | "warn";
  detail: string;
};
export type GateResult = { findings: GateFinding[]; report: string; citations: string };

// --- Pure helpers ---

const TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
export function isTestPath(p: string): boolean {
  return TEST_RE.test(p) || /(^|\/)tests?\//.test(p);
}

// Declared set = full paths + basenames appearing as tokens in the plan text.
// ponytail: This regex is intentionally loose — it matches any word.ext token (e.g. "e.g"
// registers as a path). This makes the file-set check more permissive than it appears,
// which is the safe direction for a check that can force FAIL. Do not mistake this for
// a strict allowlist; expect some false negatives (unexpected files passing through).
export function extractDeclaredPaths(planText: string): Set<string> {
  const set = new Set<string>();
  for (const m of planText.matchAll(/[\w./-]*[\w-]\.[a-z]{1,5}\b/gi)) {
    const t = m[0].replace(/^\.?\//, "");
    set.add(t);
    set.add(t.split("/").pop()!);
  }
  return set;
}

// drizzle-kit generates the SQL, snapshot and journal as one unit whenever the
// plan changes the schema. Plans name these in prose ("drizzle/ (generated)")
// which the literal path extractor cannot see, and the trio has now produced
// three identical false-positive blocks. If the plan declared the schema file,
// the generated companions are in scope by construction.
function isDrizzleCompanion(p: string, declared: Set<string>): boolean {
  const declaresSchema = [...declared].some((d) => d.endsWith("schema.ts") || d.startsWith("drizzle"));
  return declaresSchema && (/^drizzle\/meta\//.test(p) || /^drizzle\/[^/]+\.sql$/.test(p));
}

export function unexpectedFiles(changed: string[], declared: Set<string>, allowGlobs: string[]): string[] {
  return changed.filter(p =>
    !declared.has(p) && !declared.has(p.split("/").pop()!) && !matchAny(p, allowGlobs)
    && !isDrizzleCompanion(p, declared),
  );
}

// "Acceptance criteria" bullet/line block from the ticket body.
export function extractAcceptanceCriteria(body: string): string[] {
  const lines = body.split(/\r?\n/);
  let inAC = false;
  const criteria: string[] = [];
  for (const line of lines) {
    if (/acceptance\s+criteria/i.test(line)) { inAC = true; continue; }
    if (inAC) {
      // Stop at next section header (##, all-caps line, or blank line after content)
      if (/^##/.test(line) || (criteria.length && !line.trim())) break;
      const clean = line.replace(/^[\s\-*\d.]+/, "").trim();
      if (clean) criteria.push(clean);
    }
  }
  return criteria;
}

// AC keywords appear in at least one changed-test file's text => matched.
export function unmatchedCriteria(criteria: string[], testTexts: string[]): string[] {
  const joined = testTexts.join(" ").toLowerCase();
  return criteria.filter(ac => {
    const tokens = ac.toLowerCase().split(/\W+/).filter(w => w.length >= 4);
    return !tokens.some(t => joined.includes(t));
  });
}

const DOC_RE = /\.(md|mdx|markdown|txt)$/i;
export function isDocPath(p: string): boolean {
  return DOC_RE.test(p);
}

// Per-file added-line text from a `git log -p` range patch. Keyed by the
// `+++ b/<path>` header; collects '+' lines (not '+++'), leading '+' stripped.
export function addedLinesByFile(patch: string): Map<string, string> {
  const acc = new Map<string, string[]>();
  let cur: string | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git")) { cur = null; continue; }
    const pp = line.match(/^\+\+\+ b\/(.+)$/);
    if (pp) { cur = pp[1].replace(/\r$/, ""); if (!acc.has(cur)) acc.set(cur, []); continue; }
    if (cur && line.startsWith("+") && !line.startsWith("+++")) {
      acc.get(cur)!.push(line.slice(1).replace(/\r$/, ""));
    }
  }
  const out = new Map<string, string>();
  for (const [k, v] of acc) out.set(k, v.join("\n"));
  return out;
}

export type CitationRef = { raw: string; path: string; start: number; end: number };

// `path.ext:line` or `path.ext:line-line`. Requires a file extension so prose
// like "step 3:12" never matches. Bare paths with no line are NOT citations
// (handled by the reviewer obligation, not mechanically).
export function extractCitations(text: string): CitationRef[] {
  const out: CitationRef[] = [];
  for (const m of text.matchAll(/(?<![\w/])([\w./-]*[\w-]\.[a-z]{1,6}):(\d+)(?:-(\d+))?/gi)) {
    const path = m[1].replace(/^\.?\//, "");
    const start = parseInt(m[2], 10);
    const end = m[3] ? parseInt(m[3], 10) : start;
    out.push({ raw: m[0], path, start, end });
  }
  return out;
}

export type CitationCheck =
  | { ref: CitationRef; status: "missing" }
  | { ref: CitationRef; status: "out-of-range"; lineCount: number }
  | { ref: CitationRef; status: "ok"; quoted: string };

// Resolve against the worktree. Path-traversal (`..`) => missing (trust boundary).
export function resolveCitation(sandbox: string, ref: CitationRef): CitationCheck {
  if (ref.path.split("/").includes("..")) return { ref, status: "missing" };
  let content: string;
  try {
    content = readFileSync(join(sandbox, ref.path), "utf-8");
  } catch {
    return { ref, status: "missing" };
  }
  const lines = content.split(/\r?\n/);
  if (ref.start < 1 || ref.end < ref.start || ref.end > lines.length) {
    return { ref, status: "out-of-range", lineCount: lines.length };
  }
  return { ref, status: "ok", quoted: lines.slice(ref.start - 1, ref.end).join("\n") };
}

// Candidate when small guard + new test(s). null => probe N/A (not a finding).
export function mutationCandidate(
  nameStatus: { status: "A" | "M" | "D"; path: string }[],
  maxSource: number,
): { testFiles: string[]; sourceFiles: { status: "A" | "M" | "D"; path: string }[] } | null {
  const tests = nameStatus.filter(f => f.status === "A" && isTestPath(f.path));
  const source = nameStatus.filter(f => (f.status === "A" || f.status === "M") && !isTestPath(f.path));
  if (tests.length < 1) return null;
  if (source.length < 1 || source.length > maxSource) return null;
  return { testFiles: tests.map(t => t.path), sourceFiles: source };
}

// --- Mutation command resolution ---

export function resolveMutationCmd(setting: string | null, sandbox: string): (file: string) => string | null {
  if (setting && setting.includes("{file}")) {
    return (file: string) => setting.replace("{file}", file);
  }
  // Detect vitest
  try {
    const pkg = JSON.parse(readFileSync(join(sandbox, "package.json"), "utf-8"));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (deps.vitest || pkg.scripts?.test?.includes("vitest")) {
      return (file: string) => `npx vitest run ${file}`;
    }
  } catch { /* no package.json */ }
  return () => null;
}

// --- Orchestrator ---

const REPORT_CAP = 8_000;

export async function runGate(deps: {
  workdir: string;
  ticketId: string;
  planText: string;
  ticketBody: string;
  maxSourceFiles: number;
  mutationCmd: (file: string) => string | null;
  rangePatch?: string;
  changedPaths?: string[];
}): Promise<GateResult> {
  const findings: GateFinding[] = [];
  const { workdir, ticketId, planText, ticketBody, maxSourceFiles, mutationCmd } = deps;
  const sandbox = sandboxPath(ticketId);

  // The review path already computes both once and passes them in; fall back to
  // computing lazily and memoizing so each git call fires at most once here.
  let rangePatchCache = deps.rangePatch;
  const getRangePatch = async () => (rangePatchCache ??= await sandboxRangePatch(workdir, ticketId));
  let changedPathsCache = deps.changedPaths;
  const getChangedPaths = async () => (changedPathsCache ??= await sandboxDiffNames(workdir, ticketId));

  // 1. Secret scan — scan '+' addition lines from the full range patch
  try {
    const patch = await getRangePatch();
    const additions = patch.split("\n")
      .filter(l => l.startsWith("+") && !l.startsWith("+++"))
      .join("\n");
    const secrets = findSecrets(additions);
    if (secrets.length) {
      findings.push({
        check: "secret",
        severity: "block",
        detail: `Secret(s) detected in branch history (base..HEAD): ${secrets.join(", ")}`,
      });
    }
  } catch (e) {
    findings.push({ check: "secret", severity: "warn", detail: `Secret scan error: ${(e as Error).message}` });
  }

  // 2. File-set check
  try {
    const changed = await getChangedPaths();
    const declared = extractDeclaredPaths(planText);
    const allow = parseAllowFiles(ticketBody);
    const unexpected = unexpectedFiles(changed, declared, allow);
    if (unexpected.length) {
      findings.push({
        check: "file-set",
        severity: "block",
        detail: `File(s) outside the plan-declared set: ${unexpected.join(", ")}`,
      });
    }
  } catch (e) {
    findings.push({ check: "file-set", severity: "warn", detail: `File-set check error: ${(e as Error).message}` });
  }

  // 3. Mutation probe
  try {
    const ns = await sandboxDiffNameStatus(workdir, ticketId);
    const cand = mutationCandidate(ns, maxSourceFiles);
    if (cand) {
      const base = await sandboxBaseCommit(workdir, ticketId);
      const srcPaths = cand.sourceFiles.map(f => f.path);
      const modified = cand.sourceFiles.filter(f => f.status === "M").map(f => f.path);
      const added = cand.sourceFiles.filter(f => f.status === "A").map(f => f.path);
      try {
        // Revert guard: checkout base for M, delete A
        if (modified.length) await sandboxCheckout(ticketId, base, modified);
        if (added.length) await sandboxDeletePaths(ticketId, added);

        for (const testFile of cand.testFiles) {
          const cmd = mutationCmd(testFile);
          if (!cmd) {
            findings.push({ check: "mutation", severity: "warn", detail: `No test runner configured for ${testFile}` });
            continue;
          }
          const [result] = await runChecks([cmd], sandbox);
          if (result.code === 0) {
            findings.push({
              check: "mutation",
              severity: "block",
              detail: `Dead test: ${testFile} passes with the guard reverted (exit 0)`,
            });
          }
        }
      } finally {
        // Restore: checkout HEAD for all modified/added paths
        try {
          await sandboxCheckout(ticketId, "HEAD", srcPaths);
        } catch (restoreErr) {
          findings.push({
            check: "mutation",
            severity: "warn",
            detail: `Mutation restore failed: ${(restoreErr as Error).message}. Sandbox working tree may be dirty; the committed state and promote are unaffected.`,
          });
        }
      }
    }
  } catch (e) {
    findings.push({ check: "mutation", severity: "warn", detail: `Mutation probe error: ${(e as Error).message}` });
  }

  // 4. AC-map (warn only)
  try {
    const criteria = extractAcceptanceCriteria(ticketBody);
    if (criteria.length) {
      const changed = await getChangedPaths();
      const testFiles = changed.filter(isTestPath);
      const testTexts: string[] = [];
      for (const tf of testFiles) {
        try { testTexts.push(readFileSync(join(sandbox, tf), "utf-8")); } catch { /* file may be deleted */ }
      }
      const unmatched = unmatchedCriteria(criteria, testTexts);
      if (unmatched.length) {
        findings.push({
          check: "ac-map",
          severity: "warn",
          detail: `Acceptance criteria possibly not asserted: ${unmatched.map(c => `"${c.slice(0, 60)}"`).join("; ")}`,
        });
      }
    }
  } catch (e) {
    findings.push({ check: "ac-map", severity: "warn", detail: `AC-map check error: ${(e as Error).message}` });
  }

  // 5. Doc citation check — dangling/out-of-range => block; in-range => quote
  // the cited text for the reviewer to compare against the doc's claim.
  const citationEvidence: string[] = [];
  try {
    const patch = await getRangePatch();
    const byFile = addedLinesByFile(patch);
    const seen = new Set<string>();
    for (const [path, added] of byFile) {
      if (!isDocPath(path)) continue;
      for (const ref of extractCitations(added)) {
        if (seen.has(ref.raw)) continue;
        seen.add(ref.raw);
        const c = resolveCitation(sandbox, ref);
        if (c.status === "missing") {
          findings.push({ check: "citation", severity: "block",
            detail: `Dangling citation ${c.ref.raw} — file not found in the worktree` });
        } else if (c.status === "out-of-range") {
          findings.push({ check: "citation", severity: "block",
            detail: `Out-of-range citation ${c.ref.raw} — ${c.ref.path} has ${c.lineCount} lines` });
        } else {
          citationEvidence.push(`${c.ref.raw}:\n${c.quoted}`);
        }
      }
    }
  } catch (e) {
    findings.push({ check: "citation", severity: "warn", detail: `Citation check error: ${(e as Error).message}` });
  }

  // Build report
  const blocks = findings.filter(f => f.severity === "block");
  const warns = findings.filter(f => f.severity === "warn");
  let report = "";
  for (const f of blocks) {
    report += `AUTOMATIC BLOCK — promotion is blocked regardless of the review verdict.\n[${f.check}] ${f.detail}\n\n`;
  }
  for (const f of warns) {
    report += `WARNING (advisory)\n[${f.check}] ${f.detail}\n\n`;
  }
  report = redactSecrets(report.trim()).slice(0, REPORT_CAP);

  const citations = redactSecrets(citationEvidence.join("\n\n")).slice(0, REPORT_CAP);
  return { findings, report, citations };
}
