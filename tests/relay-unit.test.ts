import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, describe, it } from "vitest";
import { composePlanPrompt, composeWorkPrompt, composeReviewPrompt, parseVerdict, parseReason } from "../src/relay/prompts.js";
import { loadRelayConfig, resolveCmd } from "../src/relay/config.js";
import { substituteCmd, runAgent, killTree } from "../src/relay/invoke.js";
import { spawn } from "node:child_process";

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

test("composeReviewPrompt with amendments marks supervisor scope as requested, keeps the out-of-scope guard", () => {
  const prompt = composeReviewPrompt({
    ticket: { title: "Fix the widget" },
    plan: "1. Replace the gear",
    report: "REPORT: done",
    diff: "diff --git a/gear.ts b/gear.ts",
    amendments: "CHANGE REQUEST:\nAlso add a DEPS-LEAK hint and a test for it",
  });
  expect(prompt).toContain("AUTHORITATIVE PLAN AMENDMENTS");
  expect(prompt).toContain("DEPS-LEAK hint and a test for it");
  expect(prompt).toContain('<UNTRUSTED label="plan-amendments">');
  // Must NOT become permissive: plan is still the contract and unrequested scope still fails.
  expect(prompt).toContain("Replace the gear");
  expect(prompt).toContain("in NEITHER the plan NOR these amendments");
  expect(prompt).toContain("VERDICT: PASS");
  expect(prompt).toContain("VERDICT: FAIL");
});

test("composeReviewPrompt without amendments has no amendments section (no weakening on normal runs)", () => {
  const prompt = composeReviewPrompt({
    ticket: { title: "Fix the widget" },
    plan: "1. Replace the gear",
    report: "REPORT: done",
    diff: "diff --git a/gear.ts b/gear.ts",
  });
  expect(prompt).not.toContain("AUTHORITATIVE PLAN AMENDMENTS");
});

test("composeReviewPrompt with citations includes DOC CITATION OBLIGATION and quoted evidence", () => {
  const prompt = composeReviewPrompt({
    ticket: { title: "Add design doc" },
    plan: "1. Write design doc",
    report: "REPORT: done",
    diff: "diff --git a/docs/spec.md b/docs/spec.md",
    citations: "src/a.ts:5:\nfoo",
  });
  expect(prompt).toContain("DOC CITATION OBLIGATION");
  expect(prompt).toContain("may NOT return VERDICT: PASS");
  expect(prompt).toContain('<UNTRUSTED label="citations">');
  expect(prompt).toContain("src/a.ts:5:\nfoo");
});

test("composeReviewPrompt without citations has no DOC CITATION OBLIGATION section", () => {
  const prompt = composeReviewPrompt({
    ticket: { title: "Fix bug" },
    plan: "1. Fix",
    report: "REPORT: done",
    diff: "diff --git a/fix.ts b/fix.ts",
  });
  expect(prompt).not.toContain("DOC CITATION OBLIGATION");
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

test("parseVerdict takes the last line-anchored verdict (fail-closed vs narration)", () => {
  expect(parseVerdict("I would mark this VERDICT: PASS if not for X.\nVERDICT: FAIL\n- fix X").pass).toBe(false);
  expect(parseVerdict("narration\n  VERDICT: PASS").pass).toBe(true);
  expect(parseVerdict("mentions VERDICT: FAIL early\nVERDICT: PASS").pass).toBe(true);
});

test("runAgent streams chunks to onData as they arrive", async () => {
  process.env.FAKE_MODE = "plan";
  const chunks: string[] = [];
  const agent = { cmd: [process.execPath, "tests/fixtures/fake-agent.mjs", "{prompt}"], roles: ["plan"] };
  const res = await runAgent(agent, "hi", process.cwd(), (c) => chunks.push(c));
  expect(res.ok).toBe(true);
  expect(chunks.join("")).toContain("do the thing");
  expect(res.output).toContain("do the thing");
  delete process.env.FAKE_MODE;
});

test("runAgent pipes the prompt over stdin when cmd has no placeholder", async () => {
  process.env.FAKE_MODE = "echo-stdin";
  // No {prompt}/{promptFile} in cmd: Windows argv caps at ~32k, so long prompts
  // (review diffs) must arrive on stdin instead.
  const agent = { cmd: [process.execPath, "tests/fixtures/fake-agent.mjs"], roles: ["review"] };
  const big = "stdin-roundtrip " + "x".repeat(40_000);
  const res = await runAgent(agent, big, process.cwd());
  expect(res.ok).toBe(true);
  expect(res.output).toContain("STDIN:stdin-roundtrip");
  expect(res.output.length).toBeGreaterThan(40_000);
  delete process.env.FAKE_MODE;
});

test("relay --version prints package version and exits 0", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
  const res = await runAgent(
    { cmd: [process.execPath, "node_modules/tsx/dist/cli.mjs", "src/relay/runner.ts", "--version"], roles: [] },
    "unused",
    process.cwd(),
  );
  expect(res.ok).toBe(true);
  expect(res.output.trim()).toBe(pkg.version);
});

test("loadRelayConfig accepts a valid models list", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-cfg-"));
  const path = join(dir, "relay.json");
  writeFileSync(path, JSON.stringify({
    workdir: dir,
    agents: {
      claude: {
        cmd: ["claude", "-p", "{promptFile}", "--model", "{model}"],
        roles: ["plan"],
        models: [{ name: "opus", tier: "expensive", quality: 5 }, { name: "haiku", tier: "free", quality: 3 }],
      },
    },
  }));
  try {
    const config = loadRelayConfig(path);
    expect(config.agents.claude.models).toEqual([
      { name: "opus", tier: "expensive", quality: 5 }, { name: "haiku", tier: "free", quality: 3 },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRelayConfig rejects an empty models array", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-cfg-"));
  const path = join(dir, "relay.json");
  writeFileSync(path, JSON.stringify({
    workdir: dir,
    agents: { bad: { cmd: ["claude"], roles: ["plan"], models: [] } },
  }));
  try {
    expect(() => loadRelayConfig(path)).toThrow(/models must be a non-empty array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRelayConfig rejects a model with an invalid tier", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-cfg-"));
  const path = join(dir, "relay.json");
  writeFileSync(path, JSON.stringify({
    workdir: dir,
    agents: { bad: { cmd: ["claude"], roles: ["plan"], models: [{ name: "x", tier: "gold", quality: 3 }] } },
  }));
  try {
    expect(() => loadRelayConfig(path)).toThrow(/invalid tier/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRelayConfig rejects a model with an out-of-range quality", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-cfg-"));
  const path = join(dir, "relay.json");
  writeFileSync(path, JSON.stringify({
    workdir: dir,
    agents: { bad: { cmd: ["claude"], roles: ["plan"], models: [{ name: "x", tier: "free", quality: 9 }] } },
  }));
  try {
    expect(() => loadRelayConfig(path)).toThrow(/quality must be an integer 1-5/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveCmd substitutes {model} with the requested model, validating membership", () => {
  const agent = {
    cmd: ["claude", "-p", "{promptFile}", "--model", "{model}"], roles: ["plan"],
    models: [{ name: "opus", tier: "expensive" as const, quality: 5 }, { name: "haiku", tier: "free" as const, quality: 3 }],
  };
  expect(resolveCmd(agent, "haiku")).toEqual(["claude", "-p", "{promptFile}", "--model", "haiku"]);
});

test("resolveCmd defaults to the first model when none is requested", () => {
  const agent = {
    cmd: ["claude", "--model", "{model}"], roles: ["plan"],
    models: [{ name: "opus", tier: "expensive" as const, quality: 5 }, { name: "haiku", tier: "free" as const, quality: 3 }],
  };
  expect(resolveCmd(agent)).toEqual(["claude", "--model", "opus"]);
});

test("resolveCmd leaves cmd untouched when the agent has no models and none was requested", () => {
  const agent = { cmd: ["codex", "exec", "{prompt}"], roles: ["work"] };
  expect(resolveCmd(agent)).toEqual(["codex", "exec", "{prompt}"]);
});

test("resolveCmd throws when a model is requested but the agent has no models", () => {
  const agent = { cmd: ["codex", "exec", "{prompt}"], roles: ["work"] };
  expect(() => resolveCmd(agent, "gpt-5")).toThrow(/does not support model selection/);
});

test("resolveCmd throws when a model is requested but cmd has no {model} placeholder", () => {
  const agent = {
    cmd: ["claude", "-p", "{promptFile}"], roles: ["plan"],
    models: [{ name: "opus", tier: "expensive" as const, quality: 5 }],
  };
  expect(() => resolveCmd(agent, "opus")).toThrow(/does not support model selection/);
});

test("resolveCmd throws for a model unknown to the agent", () => {
  const agent = {
    cmd: ["claude", "--model", "{model}"], roles: ["plan"],
    models: [{ name: "opus", tier: "expensive" as const, quality: 5 }],
  };
  expect(() => resolveCmd(agent, "nope")).toThrow(/unknown model "nope"/);
});

test("runAgent merges agent.env over process.env for the child (override + inherited PATH)", async () => {
  const agent = {
    cmd: [process.execPath, "-e", "process.stdout.write(process.env.FOO + '|' + (process.env.PATH ? 'PATH' : 'NOPATH'))"],
    roles: [], env: { FOO: "bar" },
  };
  const res = await runAgent(agent, "unused", process.cwd());
  expect(res.ok).toBe(true);
  expect(res.output).toContain("bar|PATH");
});

test("runAgent substitutes {workdir} in env values", async () => {
  const agent = {
    cmd: [process.execPath, "-e", "process.stdout.write(process.env.WD)"],
    roles: [], env: { WD: "{workdir}" },
  };
  const res = await runAgent(agent, "unused", process.cwd());
  expect(res.ok).toBe(true);
  expect(res.output).toContain(process.cwd());
});

test("runAgent without env leaves the child inheriting the parent env", async () => {
  process.env.INHERIT_PROBE = "seen";
  const agent = {
    cmd: [process.execPath, "-e", "process.stdout.write(process.env.INHERIT_PROBE ?? 'MISSING')"],
    roles: [],
  };
  const res = await runAgent(agent, "unused", process.cwd());
  expect(res.output).toContain("seen");
  delete process.env.INHERIT_PROBE;
});

test("loadRelayConfig rejects a non-string env value, naming the agent", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-cfg-"));
  const path = join(dir, "relay.json");
  writeFileSync(path, JSON.stringify({
    workdir: dir,
    agents: { kimi: { cmd: ["claude"], roles: ["work"], env: { ANTHROPIC_AUTH_TOKEN: 123 } } },
  }));
  try {
    expect(() => loadRelayConfig(path)).toThrow(/agent "kimi" env value "ANTHROPIC_AUTH_TOKEN" must be a string/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRelayConfig rejects an array env, naming the agent", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-cfg-"));
  const path = join(dir, "relay.json");
  writeFileSync(path, JSON.stringify({
    workdir: dir,
    agents: { kimi: { cmd: ["claude"], roles: ["work"], env: ["x"] } },
  }));
  try {
    expect(() => loadRelayConfig(path)).toThrow(/agent "kimi" env must be an object/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRelayConfig accepts a valid env object", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-cfg-"));
  const path = join(dir, "relay.json");
  writeFileSync(path, JSON.stringify({
    workdir: dir,
    agents: { kimi: { cmd: ["claude", "-p"], roles: ["work"], env: { ANTHROPIC_BASE_URL: "https://api.moonshot.ai/anthropic" } } },
  }));
  try {
    expect(loadRelayConfig(path).agents.kimi.env).toEqual({ ANTHROPIC_BASE_URL: "https://api.moonshot.ai/anthropic" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRelayConfig accepts an sdk agent without cmd", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-cfg-"));
  const path = join(dir, "relay.json");
  writeFileSync(path, JSON.stringify({
    workdir: dir,
    agents: { sonnet: { type: "sdk", roles: ["work"] } },
  }));
  try {
    const config = loadRelayConfig(path);
    expect(config.agents.sonnet.type).toBe("sdk");
    expect(config.agents.sonnet.cmd).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loadRelayConfig rejects an sdk agent with non-work roles", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-cfg-"));
  const path = join(dir, "relay.json");
  writeFileSync(path, JSON.stringify({
    workdir: dir,
    agents: { bad: { type: "sdk", roles: ["plan", "work"] } },
  }));
  try {
    expect(() => loadRelayConfig(path)).toThrow(/of type sdk can only have the "work" role in Phase 1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loadRelayConfig rejects an unknown agent type, naming the agent", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-cfg-"));
  const path = join(dir, "relay.json");
  writeFileSync(path, JSON.stringify({
    workdir: dir,
    agents: { bad: { type: "grpc", roles: ["work"] } },
  }));
  try {
    expect(() => loadRelayConfig(path)).toThrow(/agent "bad" type must be "cli" or "sdk"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loadRelayConfig still requires cmd for a cli agent", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-cfg-"));
  const path = join(dir, "relay.json");
  writeFileSync(path, JSON.stringify({
    workdir: dir,
    agents: { c: { type: "cli", roles: ["work"] } },
  }));
  try {
    expect(() => loadRelayConfig(path)).toThrow(/must have a non-empty cmd string array/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runAgent leaves no prompt file behind on failure and timeout paths (net-zero .txt)", async () => {
  // Note: this covers the failure and timeout paths leaving no prompt file behind.
  // It does not cover the narrow window of a throw between writeFile and try.
  const countTxt = () =>
    readdirSync(tmpdir()).filter((f) => f.startsWith("vibeops-relay-") && f.endsWith(".txt")).length;
  const before = countTxt();

  // needsFile=true (cmd contains "{promptFile}"); node ignores the extra arg and exits 1.
  const failed = await runAgent(
    { cmd: [process.execPath, "-e", "process.exit(1)", "{promptFile}"], roles: [] },
    "unused", process.cwd(),
  );
  expect(failed.ok).toBe(false);

  // needsFile=true; process hangs and is killed by the timeout (kill path).
  const timedOut = await runAgent(
    { cmd: [process.execPath, "-e", "setTimeout(()=>{},60000)", "{promptFile}"], roles: [], timeoutMs: 500 },
    "unused", process.cwd(),
  );
  expect(timedOut.ok).toBe(false);

  expect(countTxt()).toBe(before);
}, 10_000);

describe("killTree", () => {
  it("resolves promptly on an already-exited child, not after KILL_TIMEOUT_MS", async () => {
    const child = spawn(process.execPath, ["-e", "0"]);
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);

    const start = Date.now();
    await killTree(child);
    const elapsed = Date.now() - start;
    // Guard returns immediately; without it, awaiting the never-firing "exit"
    // would block the full 10s KILL_TIMEOUT_MS.
    expect(elapsed).toBeLessThan(1000);
  });
});

// EXIT_DRAIN_MS = 2000 in invoke.ts. The test asserts timing against this window.
const EXIT_DRAIN_MS = 2000;

test("runAgent settles via exit-drain when a grandchild holds the stdout pipe open", async () => {
  // Repro of the live hang: a CLI agent (agy exec) exited but a lingering
  // subprocess inherited its stdout pipe, so "close" never fired and the run sat
  // "running" past its timeout. The parent below spawns a grandchild that
  // inherits stdout and ACTIVELY WRITES to it on an interval to keep the handle
  // demonstrably open. The parent exits immediately; runAgent must still settle
  // via the exit-drain path within EXIT_DRAIN_MS, not the 60s timeout.
  //
  // Without the exit handler fix, this test times out because "close" never fires
  // while the grandchild is writing. With the fix, runAgent settles in ~2s.
  const script =
    "const{spawn}=require('node:child_process');" +
    // Grandchild writes to stdout every 100ms for 60s — keeps the pipe handle open.
    "const gc=spawn(process.execPath,['-e','" +
      "setInterval(()=>process.stdout.write(String.fromCharCode(0)),100);" +
      "setTimeout(()=>process.exit(0),60000);" +
    "'],{stdio:['ignore','inherit','inherit'],detached:true});" +
    "gc.unref();" +
    "console.log('GCPID:'+gc.pid);" +
    "console.log('parent-done');" +
    "process.exit(0);";
  const start = Date.now();
  const result = await runAgent(
    { cmd: [process.execPath, "-e", script], roles: [], timeoutMs: 60_000 },
    "unused", process.cwd(),
  );
  const elapsed = Date.now() - start;
  try {
    expect(result.output).toContain("parent-done");
    expect(result.ok).toBe(true);
    // Settled via exit-drain (~EXIT_DRAIN_MS), not instantly (would be <500ms if
    // close fired normally) and not at the 60s timeout (would exceed 10s).
    // If the fix is removed, this test times out or takes 60s.
    expect(elapsed).toBeGreaterThanOrEqual(EXIT_DRAIN_MS - 500);
    expect(elapsed).toBeLessThan(EXIT_DRAIN_MS + 3000);
  } finally {
    const m = result.output.match(/GCPID:(\d+)/);
    if (m) { try { process.kill(Number(m[1])); } catch { /* already gone */ } }
  }
}, 15_000);

test("runAgent settles immediately via close in the normal case, not waiting for exit-drain", async () => {
  // Companion to the above: when close fires normally (no pipe held open), runAgent
  // settles immediately — it does NOT wait the full EXIT_DRAIN_MS. This proves the
  // fix doesn't regress the common case.
  const start = Date.now();
  const result = await runAgent(
    { cmd: [process.execPath, "-e", "console.log('fast');process.exit(0)"], roles: [] },
    "unused", process.cwd(),
  );
  const elapsed = Date.now() - start;

  expect(result.output).toContain("fast");
  expect(result.ok).toBe(true);
  // Normal case: close fires immediately, well under EXIT_DRAIN_MS.
  expect(elapsed).toBeLessThan(EXIT_DRAIN_MS - 500);
}, 5_000);

describe("parseReason", () => {
  it("extracts the explicit REASON line", () => {
    expect(parseReason("prose\n- Critical: x\nREASON: The auth check is inverted.\nVERDICT: FAIL"))
      .toBe("The auth check is inverted.");
  });
  it("falls back to the first Critical finding's first sentence when REASON absent", () => {
    expect(parseReason("prose\n- Critical: the auth check uses < not <=. More text.\nVERDICT: FAIL"))
      .toBe("the auth check uses < not <=.");
  });
  it("falls back to the first non-marker line when neither REASON nor Critical present", () => {
    expect(parseReason("The widget crashes on empty input. Details follow.\nVERDICT: FAIL"))
      .toBe("The widget crashes on empty input.");
  });
  it("returns empty string for empty output", () => {
    expect(parseReason("")).toBe("");
  });
});
