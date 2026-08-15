#!/usr/bin/env node
// Stub agent for relay/forge pipeline tests: ignores the prompt it's given (argv[2],
// falling back to stdin) and prints a canned response selected by FAKE_MODE, or, when
// FAKE_SCRIPT is set, by a comma list consumed left-to-right via FAKE_COUNTER_FILE
// (clamped to the last entry once the script is exhausted).
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmdirSync } from "node:fs";
import { join, dirname } from "node:path";

const prompt = process.argv[2] ?? "";
void prompt;

if (process.argv.includes("--version")) {
  console.log("fake-agent 1.0.0");
  process.exit(0);
}

const OUTPUTS = {
  // Plan output must mention files the worker writes to avoid file-set gate block.
  // vitest.config.ts is for protected-path tests; run*-output.txt for concurrency tests.
  // readme.md is for the re-index test.
  plan: "1. do the thing\nFiles: forge-made.txt, src/feature.ts, vitest.config.ts, run1-output.txt, run2-output.txt, readme.md",
  work: "did it\nREPORT: changed x",
  "review-pass": "looks good\nVERDICT: PASS",
  "review-fail": "broken\nVERDICT: FAIL\n- fix y",
  "review-fail-reason": "The widget is broken.\n- Critical: the widget crashes on empty input\nREASON: The widget crashes on empty input.\nVERDICT: FAIL\n- fix it",
  "persona": "persona view: fine idea",
  "believer": "believer view: fine idea",
  "investor": "investor view: fine idea",
  "skeptic": "skeptic view: fine idea",
  "chairman-go": "looks good\nRATING: 8/10\nDECISION: GO\nTITLE: Council test ticket\nSPEC:\nspec line 1\nspec line 2",
  "chairman-questions": "need info\nRATING: 5/10\nDECISION: NEEDS-INFO\nQUESTIONS:\n- q1\n- q2\nTITLE: Council test ticket\nSPEC:\nspec line 1",
  "analyzer": "analysis done\nPROPOSAL:\n{\"decision\":\"propose\",\"kind\":\"grep-diff\",\"pattern\":\"MARKER-LESSON-42\"}",
  "plan-mismatch": "1. do the thing\n[FAKE-MODEL: wrong-model]",
  "plan-match": "1. do the thing\n[FAKE-MODEL: fast]",
};

function selectMode() {
  const script = process.env.FAKE_SCRIPT;
  if (!script) return process.env.FAKE_MODE;
  const steps = script.split(",");
  const counterFile = process.env.FAKE_COUNTER_FILE;
  const lockDir = counterFile + ".lock";
  let i = 0;
  const start = Date.now();
  while (true) {
    try {
      mkdirSync(lockDir);
      i = existsSync(counterFile) ? Number(readFileSync(counterFile, "utf-8")) : 0;
      writeFileSync(counterFile, String(i + 1));
      rmdirSync(lockDir);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - start > 5000) throw new Error("Timeout acquiring fake-agent lock");
    }
  }
  return steps[Math.min(i, steps.length - 1)];
}

let mode = selectMode();

if (mode === "persona" || mode === "believer" || mode === "investor" || mode === "skeptic") {
  if (prompt.includes("optimist")) mode = "believer";
  else if (prompt.includes("realist")) mode = "investor";
  else if (prompt.includes("roaster")) mode = "skeptic";
}

if (mode === "persona-staggered") {
  let role = "believer";
  if (prompt.includes("realist")) role = "investor";
  else if (prompt.includes("roaster")) role = "skeptic";
  const delay = { believer: 300, investor: 150, skeptic: 0 }[role];
  await new Promise((r) => setTimeout(r, delay));
  console.log(OUTPUTS[role]);
  process.exit(0);
}

if (mode === "exit") {
  console.error("boom");
  process.exit(1);
}
if (mode === "write-then-exit") {
  // Write a file (complete work) then exit non-zero to simulate agent timeout
  writeFileSync(join(process.cwd(), "forge-made.txt"), "made by fake agent\n");
  console.error("Error: timeout waiting for response");
  process.exit(1);
}
if (mode === "slow") {
  await new Promise((r) => setTimeout(r, 2000));
  console.log(OUTPUTS.plan);
  process.exit(0);
}
if (mode === "review-pass-slow") {
  await new Promise((r) => setTimeout(r, 4000));
  console.log(OUTPUTS["review-pass"]);
  process.exit(0);
}
if (mode === "review-hang") {
  await new Promise(() => {}); // hang forever
}
if (mode === "plan-hang") {
  await new Promise(() => {}); // hang forever
}
if (mode === "work-hang") {
  // Write partial edits then hang forever (to simulate being killed mid-work)
  writeFileSync(join(process.cwd(), "partial.txt"), "partial work\n");
  await new Promise(() => {}); // hang forever
}
if (mode === "leaky") {
  console.log("token sk-abcdefghij0123456789");
  process.exit(0);
}
if (mode === "echo-stdin") {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  console.log(`STDIN:${data}`);
  process.exit(0);
}
if (mode === "echo-prompt") {
  console.log(`PROMPT:${prompt}`);
  process.exit(0);
}
if (mode === "explain-diff") {
  const c = existsSync(process.env.FAKE_COUNTER_FILE) ? readFileSync(process.env.FAKE_COUNTER_FILE, "utf-8") : "0";
  console.log(`explain-result-counter-${c}`);
  process.exit(0);
}

let out = OUTPUTS[mode];
if (!out) {
  console.error(`fake-agent: unknown FAKE_MODE "${mode}"`);
  process.exit(1);
}

// Persona re-runs (round >= 2) carry the answered questions as an untrusted qa
// fence; emit distinct text so tests can assert a persona shifted position.
if ((mode === "believer" || mode === "investor" || mode === "skeptic") && prompt.includes('label="qa"')) {
  out += " (revised after answers)";
}

if (process.env.FAKE_WRITE && mode === "work") {
  writeFileSync(join(process.cwd(), "forge-made.txt"), "made by fake agent\n");
}
// Write a file NOT in the plan's declared set — triggers file-set gate block.
if (process.env.FAKE_WRITE_STRAY && mode === "work") {
  writeFileSync(join(process.cwd(), "stray-file.txt"), "unexpected file\n");
}
if (process.env.FAKE_WRITE_PATH && mode === "work") {
  const p = join(process.cwd(), process.env.FAKE_WRITE_PATH);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "edited by fake agent\n");
}
// Reproduction of the live incident: a work agent writing an ABSOLUTE path
// outside its sandbox cwd (e.g. over the installed server.mjs).
if (process.env.FAKE_WRITE_ABS && mode === "work") {
  writeFileSync(process.env.FAKE_WRITE_ABS, "escaped build by fake agent\n");
}
// Write through the shared node_modules link back to the base repo.
if (process.env.FAKE_WRITE_DEPS && mode === "work") {
  const p = join(process.cwd(), "node_modules", process.env.FAKE_WRITE_DEPS);
  writeFileSync(p, "leaked by fake agent\n");
}

console.log(out);
