import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { composePlanPrompt, composeWorkPrompt, composeReviewPrompt, parseVerdict } from "../src/relay/prompts.js";
import { loadRelayConfig } from "../src/relay/config.js";
import { substituteCmd, runAgent } from "../src/relay/invoke.js";

test("parseVerdict: PASS/FAIL/missing/garbage are fail-closed", () => {
  expect(parseVerdict("some output\nVERDICT: PASS\n").pass).toBe(true);
  expect(parseVerdict("some output\nVERDICT: FAIL\nfindings here").pass).toBe(false);
  expect(parseVerdict("no verdict line at all").pass).toBe(false);
  expect(parseVerdict("").pass).toBe(false);
  expect(parseVerdict("VERDICT: MAYBE").pass).toBe(false);
});

test("composePlanPrompt includes ticket title and knowledge", () => {
  const prompt = composePlanPrompt({
    ticket: { title: "Fix the widget" },
    knowledge: [{ content: "widgets are fiddly", citation: "note-1" }],
  });
  expect(prompt).toContain("Fix the widget");
  expect(prompt).toContain("widgets are fiddly");
});

test("composeWorkPrompt includes plan and the mandatory REPORT instruction", () => {
  const prompt = composeWorkPrompt({
    ticket: { title: "Fix the widget" },
    plan: "1. Replace the gear\n2. Test it",
    knowledge: [],
    workdir: "/tmp/proj",
  });
  expect(prompt).toContain("Replace the gear");
  expect(prompt).toContain("/tmp/proj");
  expect(prompt).toContain("REPORT:");
});

test("composeReviewPrompt includes plan, report, diff, and the mandatory VERDICT instruction", () => {
  const prompt = composeReviewPrompt({
    ticket: { title: "Fix the widget" },
    plan: "1. Replace the gear",
    report: "REPORT: done, gear replaced",
    diff: "diff --git a/gear.ts b/gear.ts",
  });
  expect(prompt).toContain("Replace the gear");
  expect(prompt).toContain("gear replaced");
  expect(prompt).toContain("diff --git a/gear.ts");
  expect(prompt).toContain("VERDICT: PASS");
  expect(prompt).toContain("VERDICT: FAIL");
});

test("loadRelayConfig throws a helpful error on a missing file", () => {
  expect(() => loadRelayConfig(join(tmpdir(), "does-not-exist-relay.json")))
    .toThrow(/relay config not found/);
});

test("loadRelayConfig rejects a non-array cmd", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-cfg-"));
  const path = join(dir, "relay.json");
  writeFileSync(path, JSON.stringify({
    workdir: dir,
    agents: { bad: { cmd: "claude -p", roles: ["plan"] } },
  }));
  try {
    expect(() => loadRelayConfig(path)).toThrow(/cmd string array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRelayConfig accepts a valid config", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-cfg-"));
  const path = join(dir, "relay.json");
  writeFileSync(path, JSON.stringify({
    workdir: dir,
    agents: { fable: { cmd: ["claude", "-p", "{promptFile}"], roles: ["plan", "review"] } },
  }));
  try {
    const config = loadRelayConfig(path);
    expect(config.agents.fable.cmd).toEqual(["claude", "-p", "{promptFile}"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("substituteCmd replaces placeholders and leaves other args untouched", () => {
  const result = substituteCmd(
    ["codex", "exec", "-C", "{workdir}", "{prompt}", "--flag"],
    { workdir: "/repo", prompt: "do the thing" },
  );
  expect(result).toEqual(["codex", "exec", "-C", "/repo", "do the thing", "--flag"]);
});

test("substituteCmd leaves cmd untouched when no placeholders match", () => {
  expect(substituteCmd(["echo", "hi"], { prompt: "x" })).toEqual(["echo", "hi"]);
});

test("runAgent smoke: succeeds and captures stdout", async () => {
  const result = await runAgent(
    { cmd: [process.execPath, "-e", "console.log('hi')"], roles: [] },
    "unused", process.cwd(),
  );
  expect(result.ok).toBe(true);
  expect(result.output.trim()).toBe("hi");
});

test("runAgent smoke: kills on timeout", async () => {
  const result = await runAgent(
    { cmd: [process.execPath, "-e", "setTimeout(()=>{},60000)"], roles: [], timeoutMs: 500 },
    "unused", process.cwd(),
  );
  expect(result.ok).toBe(false);
}, 10_000);
