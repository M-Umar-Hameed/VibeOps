#!/usr/bin/env node
// Stub agent for relay pipeline tests: ignores the prompt it's given (argv[2],
// falling back to stdin) and prints a canned response selected by FAKE_MODE.
const prompt = process.argv[2] ?? "";
void prompt;

const OUTPUTS = {
  plan: "1. do the thing",
  work: "did it\nREPORT: changed x",
  "review-pass": "looks good\nVERDICT: PASS",
  "review-fail": "broken\nVERDICT: FAIL\n- fix y",
};

const out = OUTPUTS[process.env.FAKE_MODE];
if (!out) {
  console.error(`fake-agent: unknown FAKE_MODE "${process.env.FAKE_MODE}"`);
  process.exit(1);
}
console.log(out);
