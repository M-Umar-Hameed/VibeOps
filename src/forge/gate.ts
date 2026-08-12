// Mechanical review gate — deterministic checks that run before the review model.
// Block findings force VERDICT: FAIL regardless of the model's output.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findSecrets } from "./redact.js";
import { matchAny, parseAllowFiles } from "./policy.js";
import { runChecks } from "./checks.js";
import {
  sandboxPath, sandboxRangePatch, sandboxDiffNameStatus, sandboxBaseCommit,
  sandboxCheckout, sandboxDeletePaths, sandboxDiffNames,
} from "./sandbox.js";
import { redactSecrets } from "./redact.js";

// --- Types ---

export type GateFinding = {
  check: "secret" | "file-set" | "mutation" | "ac-map";
  severity: "block" | "warn";
  detail: string;
};
export type GateResult = { findings: GateFinding[]; report: string };

// --- Pure helpers ---

const TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
export function isTestPath(p: string): boolean {
  return TEST_RE.test(p) || /(^|\/)tests?\//.test(p);
}

// Declared set = full paths + basenames appearing as tokens in the plan text.
export function extractDeclaredPaths(planText: string): Set<string> {
  const set = new Set<string>();
  for (const m of planText.matchAll(/[\w./-]*[\w-]\.[a-z]{1,5}\b/gi)) {
    const t = m[0].replace(/^\.?\//, "");
    set.add(t);
    set.add(t.split("/").pop()!);
  }
  return set;
}

export function unexpectedFiles(changed: string[], declared: Set<string>, allowGlobs: string[]): string[] {
  return changed.filter(p =>
    !declared.has(p) && !declared.has(p.split("/").pop()!) && !matchAny(p, allowGlobs),
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
}): Promise<GateResult> {
  const findings: GateFinding[] = [];
  const { workdir, ticketId, planText, ticketBody, maxSourceFiles, mutationCmd } = deps;
  const sandbox = sandboxPath(ticketId);

  // 1. Secret scan — scan '+' addition lines from the full range patch
  try {
    const patch = await sandboxRangePatch(workdir, ticketId);
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
    const changed = await sandboxDiffNames(workdir, ticketId);
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
        await sandboxCheckout(ticketId, "HEAD", srcPaths);
      }
    }
  } catch (e) {
    findings.push({ check: "mutation", severity: "warn", detail: `Mutation probe error: ${(e as Error).message}` });
  }

  // 4. AC-map (warn only)
  try {
    const criteria = extractAcceptanceCriteria(ticketBody);
    if (criteria.length) {
      const changed = await sandboxDiffNames(workdir, ticketId);
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

  return { findings, report };
}
