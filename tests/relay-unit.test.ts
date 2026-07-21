import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { composePlanPrompt, composeWorkPrompt, composeReviewPrompt, parseVerdict } from "../src/relay/prompts.js";
import { loadRelayConfig, resolveCmd } from "../src/relay/config.js";
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
