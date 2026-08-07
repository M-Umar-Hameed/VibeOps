// Phase-1 scoring harness. Deterministic; calls no model.
//   tsx scripts/score-analyzer.mts             -> prints the analyzer prompt for each of the 4 real failures
//   tsx scripts/score-analyzer.mts --classify   -> reads a model output on stdin, prints propose/decline
// Controller runs each printed prompt through the REAL analyzer agent (the same
// cheapest-first plan agent the live pipeline uses at runs.ts:606-616), pipes the
// verbatim output back through --classify, and pastes raw output + classification
// into the report for all four cases. The model step is manual so the result is
// honest, not tuned to produce four "right" answers.
import { composeAnalyzerPrompt, parseProposal, formatProposal } from "../src/forge/lessons.js";

const CASES: { id: string; output: string; outcome: string }[] = [
  { id: "a-deps-leak", outcome: "status=failed stage=work",
    output: "Work stage wrote app/node_modules/.vite-temp through the shared node_modules junction into the base repo. Occurred 4+ times across 3 tickets." },
  { id: "b-bundle-only", outcome: "status=failed stage=review",
    output: "Changes passed in dev mode but stopped the esbuild-bundled sidecar from booting - once an import cycle, once a boot restructure." },
  { id: "c-no-regression-guard", outcome: "status=passed stage=review",
    output: "Fix shipped but the test passes with and without the fix; no regression guard was added." },
  { id: "d-misnamed-test", outcome: "status=passed stage=review",
    output: "A test named 'two concurrent pipelines' actually ran serially; the name does not exercise the behaviour." },
];

if (process.argv.includes("--classify")) {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  const p = parseProposal(data);
  console.log(p === null ? "NULL (unparseable)" : formatProposal(p));
} else {
  for (const c of CASES) {
    console.log(`===== CASE ${c.id} =====`);
    console.log(composeAnalyzerPrompt({ output: c.output, outcome: c.outcome }));
    console.log();
  }
}
