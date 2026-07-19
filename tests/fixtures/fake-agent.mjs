#!/usr/bin/env node
// Stub agent for relay/forge pipeline tests: ignores the prompt it's given (argv[2],
// falling back to stdin) and prints a canned response selected by FAKE_MODE, or, when
// FAKE_SCRIPT is set, by a comma list consumed left-to-right via FAKE_COUNTER_FILE
// (clamped to the last entry once the script is exhausted).
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";

const prompt = process.argv[2] ?? "";
void prompt;

const OUTPUTS = {
  plan: "1. do the thing",
  work: "did it\nREPORT: changed x",
  "review-pass": "looks good\nVERDICT: PASS",
  "review-fail": "broken\nVERDICT: FAIL\n- fix y",
  "persona": "persona view: fine idea",
  "believer": "believer view: fine idea",
  "investor": "investor view: fine idea",
  "skeptic": "skeptic view: fine idea",
  "chairman-go": "looks good\nRATING: 8/10\nDECISION: GO\nTITLE: Council test ticket\nSPEC:\nspec line 1\nspec line 2",
  "chairman-questions": "need info\nRATING: 5/10\nDECISION: NEEDS-INFO\nQUESTIONS:\n- q1\n- q2\nTITLE: Council test ticket\nSPEC:\nspec line 1",
  "analyzer": "analysis done\nLESSONS:\n- Prefer imperative single-sentence task steps.\n- MARKER-LESSON-42",
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

if (mode === "exit") {
  console.error("boom");
  process.exit(1);
}
if (mode === "slow") {
  await new Promise((r) => setTimeout(r, 2000));
  console.log(OUTPUTS.plan);
  process.exit(0);
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

const out = OUTPUTS[mode];
if (!out) {
  console.error(`fake-agent: unknown FAKE_MODE "${mode}"`);
  process.exit(1);
}

if (process.env.FAKE_WRITE && mode === "work") {
  writeFileSync(join(process.cwd(), "forge-made.txt"), "made by fake agent\n");
}

console.log(out);
