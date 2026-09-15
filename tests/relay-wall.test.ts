import { expect, test } from "vitest";
import { wallCmd, allowRules, resolveAllowedCommands, DEFAULT_ALLOWED_COMMANDS } from "../src/relay/wall.js";

const RULES = JSON.stringify({ permissions: { allow: allowRules(["npm test"]) } });
const CLAUDE_FLAGS = ["--restricted", "--permission-mode", "acceptEdits", "--permission-prompts", "none",
  "--tools", "Read,Edit,Write,Glob,Grep,Bash,PowerShell", "--settings", RULES];

test("claude: drops the prompt-file placeholder and appends the wall", () => {
  expect(wallCmd(["claude", "--model", "Opus", "-p", "{promptFile}"], ["npm test"]))
    .toEqual(["claude", "--model", "Opus", "-p", ...CLAUDE_FLAGS]);
});

test("claude: drops an inline prompt placeholder too, and works on a full .exe path", () => {
  expect(wallCmd(["C:\\x\\claude.exe", "-p", "{prompt}"], ["npm test"]))
    .toEqual(["C:\\x\\claude.exe", "-p", ...CLAUDE_FLAGS]);
});

test("claude: adds -p when the cmd has no print flag", () => {
  expect(wallCmd(["claude", "--model", "Opus"], ["npm test"]))
    .toEqual(["claude", "--model", "Opus", "-p", ...CLAUDE_FLAGS]);
});

test("claude: an already-walled cmd is left unchanged", () => {
  const walled = ["claude", "-p", "--restricted"];
  expect(wallCmd(walled, ["npm test"])).toEqual(walled);
});

test("codex: inserts the workspace-write sandbox after exec unless one is set", () => {
  expect(wallCmd(["codex", "exec", "-C", "{workdir}", "{prompt}"], []))
    .toEqual(["codex", "exec", "--sandbox", "workspace-write", "-C", "{workdir}", "{prompt}"]);
  const own = ["codex", "exec", "--sandbox", "read-only", "{prompt}"];
  expect(wallCmd(own, [])).toEqual(own);
});

test("other programs are unchanged", () => {
  const agy = ["agy", "--model", "{model}", "--dangerously-skip-permissions"];
  expect(wallCmd(agy, ["npm test"])).toEqual(agy);
  const node = [process.execPath, "agent.mjs", "{prompt}"];
  expect(wallCmd(node, ["npm test"])).toEqual(node);
});

test("allowRules gives exact and with-arguments rules for Bash and PowerShell", () => {
  expect(allowRules(["npm test"])).toEqual(["Bash(npm test)", "Bash(npm test *)", "PowerShell(npm test)", "PowerShell(npm test *)"]);
});

test("resolveAllowedCommands: valid array wins, malformed or unset falls back to the default", () => {
  expect(resolveAllowedCommands('["make"]')).toEqual(["make"]);
  expect(resolveAllowedCommands("not json")).toEqual(DEFAULT_ALLOWED_COMMANDS);
  expect(resolveAllowedCommands('{"a":1}')).toEqual(DEFAULT_ALLOWED_COMMANDS);
  expect(resolveAllowedCommands(null)).toEqual(DEFAULT_ALLOWED_COMMANDS);
});
