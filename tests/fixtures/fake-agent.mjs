#!/usr/bin/env node
// Stub agent for relay/forge pipeline tests: ignores the prompt it's given (argv[2],
// falling back to stdin) and prints a canned response selected by FAKE_MODE, or, when
// FAKE_SCRIPT is set, by a comma list consumed left-to-right via FAKE_COUNTER_FILE
// (clamped to the last entry once the script is exhausted).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const prompt = process.argv[2] ?? "";
void prompt;

const OUTPUTS = {
  plan: "1. do the thing",
  work: "did it\nREPORT: changed x",
  "review-pass": "looks good\nVERDICT: PASS",
  "review-fail": "broken\nVERDICT: FAIL\n- fix y",
};

function selectMode() {
  const script = process.env.FAKE_SCRIPT;
  if (!script) return process.env.FAKE_MODE;
  const steps = script.split(",");
  const counterFile = process.env.FAKE_COUNTER_FILE;
  const i = existsSync(counterFile) ? Number(readFileSync(counterFile, "utf-8")) : 0;
  writeFileSync(counterFile, String(i + 1));
  return steps[Math.min(i, steps.length - 1)];
}

const mode = selectMode();

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

const out = OUTPUTS[mode];
if (!out) {
  console.error(`fake-agent: unknown FAKE_MODE "${mode}"`);
  process.exit(1);
}

if (process.env.FAKE_WRITE && mode === "work") {
  writeFileSync(join(process.cwd(), "forge-made.txt"), "made by fake agent\n");
}

console.log(out);
