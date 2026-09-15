# Agent Wall Implementation Plan

**Goal:** VibeOps adds a write wall to claude, codex and the SDK lane at launch, so agents cannot write outside their working folder and can only run allow-listed commands.

**Spec:** docs/superpowers/specs/2026-09-15-agent-wall-design.md

## Global Constraints

- Default allow-list, exact: `["npm test", "npm run", "npx vitest", "npx tsc", "git status", "git diff", "git log", "git show"]`.
- claude wall flags, exact order appended: `--restricted --permission-mode acceptEdits --permission-prompts none --tools Read,Edit,Write,Glob,Grep,Bash,PowerShell --settings <json>`.
- Settings keys: `forge.agentWall` (`"false"` disables), `forge.allowedCommands` (JSON string array).
- No emojis, no em dashes, minimal comments, no co-author lines, never push. Tests on the embedded lane: `Set-Location D:\Umar\VibeOps; $env:VIBEOPS_TEST_EMBEDDED="1"; node scripts/test-lane.mjs <files>`.

---

### Task 1: `wall.ts` and its tests

**Files:** Create `src/relay/wall.ts`, `tests/relay-wall.test.ts`. Modify `src/relay/doctor.ts` (export `binBasename`).

- [ ] Step 1: in `src/relay/doctor.ts` change `function binBasename(cmd0: string): string {` to `export function binBasename(cmd0: string): string {`.
- [ ] Step 2: create `tests/relay-wall.test.ts`:

```ts
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
```

- [ ] Step 3: run the test file; expect FAIL (module missing).
- [ ] Step 4: create `src/relay/wall.ts`:

```ts
import { binBasename } from "./doctor.js";

export const DEFAULT_ALLOWED_COMMANDS = ["npm test", "npm run", "npx vitest", "npx tsc", "git status", "git diff", "git log", "git show"];

// forge.allowedCommands (JSON string array) wins; unset or malformed falls back to the default.
export function resolveAllowedCommands(setting: string | null): string[] {
  if (setting === null) return DEFAULT_ALLOWED_COMMANDS;
  try {
    const parsed: unknown = JSON.parse(setting);
    if (Array.isArray(parsed) && parsed.every((c) => typeof c === "string")) return parsed;
  } catch { /* fall through */ }
  return DEFAULT_ALLOWED_COMMANDS;
}

// Claude runs shell commands through Bash or PowerShell depending on the platform.
export function allowRules(allowed: string[]): string[] {
  return allowed.flatMap((c) => ["Bash", "PowerShell"].flatMap((t) => [`${t}(${c})`, `${t}(${c} *)`]));
}

// Per-program write wall added at launch, whatever relay.json says. claude: the
// prompt moves to stdin (a prompt file outside the folder would be refused) and
// --restricted confines its file tools to the working folder; only allow-listed
// commands run. codex: its own OS sandbox. Other programs are not walled here.
export function wallCmd(cmd: string[], allowed: string[]): string[] {
  const bin = binBasename(cmd[0]).toLowerCase();
  if (bin === "claude") {
    if (cmd.includes("--restricted")) return cmd;
    const kept = cmd.filter((p) => p !== "{prompt}" && p !== "{promptFile}");
    const print = kept.includes("-p") || kept.includes("--print") ? [] : ["-p"];
    return [...kept, ...print, "--restricted", "--permission-mode", "acceptEdits", "--permission-prompts", "none",
      "--tools", "Read,Edit,Write,Glob,Grep,Bash,PowerShell",
      "--settings", JSON.stringify({ permissions: { allow: allowRules(allowed) } })];
  }
  if (bin === "codex") {
    const i = cmd.indexOf("exec");
    if (i === -1 || cmd.includes("--sandbox")) return cmd;
    return [...cmd.slice(0, i + 1), "--sandbox", "workspace-write", ...cmd.slice(i + 1)];
  }
  return cmd;
}

// Callers without a database (the standalone relay runner) get the defaults.
export async function loadWall(): Promise<{ on: boolean; allowed: string[] }> {
  try {
    const { getSetting } = await import("../services/settings.js");
    return {
      on: (await getSetting("forge.agentWall")) !== "false",
      allowed: resolveAllowedCommands(await getSetting("forge.allowedCommands")),
    };
  } catch {
    return { on: true, allowed: DEFAULT_ALLOWED_COMMANDS };
  }
}
```

- [ ] Step 5: run the test file and `npm run typecheck`; expect PASS. Commit: `Add agent wall: per-program write wall applied at launch`.

### Task 2: apply the wall in `runAgent` and the SDK lane

**Files:** Modify `src/relay/invoke.ts`, `src/relay/invoke-sdk.ts`, `tests/invoke-sdk.test.ts`.

- [ ] Step 1: in `tests/invoke-sdk.test.ts`, inside `describe("checkToolPermission", ...)`, add:

```ts
  it("denies Bash when the wall is on and allows it when off", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "sdk-wall-"));
    const marks: string[] = [];
    expect(checkToolPermission("Bash", { command: "node -e 1" }, sandbox, (c) => marks.push(c), true).behavior).toBe("deny");
    expect(marks.join("")).toContain("permission-denied Bash");
    expect(checkToolPermission("Bash", { command: "node -e 1" }, sandbox).behavior).toBe("allow");
  });
```
(add `mkdtempSync`, `tmpdir`, `join` imports if missing). Run; expect FAIL.
- [ ] Step 2: `src/relay/invoke-sdk.ts`:
  - import `{ loadWall, allowRules }` from `"./wall.js"`.
  - `checkToolPermission` signature gains a fifth parameter `walled = false`; replace `  if (toolName === "Bash") return { behavior: "allow", updatedInput: input };` with:
```ts
  if (toolName === "Bash") {
    if (!walled) return { behavior: "allow", updatedInput: input };
    onData?.(`\n[forge: permission-denied Bash ${String(input.command ?? "").slice(0, 120)}]\n`);
    return { behavior: "deny", message: "command not in forge.allowedCommands" };
  }
```
  - in `runAgentSdk`, before `const controller`, add `const wall = await loadWall();`; in `query({ ... options: { ... } })` add after `abortController: controller,`:
```ts
        ...(wall.on ? { permissionMode: "acceptEdits" as const, settingSources: [], allowedTools: allowRules(wall.allowed) } : {}),
```
    and change the `canUseTool` body to pass `wall.on` as the fifth argument.
- [ ] Step 3: `src/relay/invoke.ts`: import `{ loadWall, wallCmd }` from `"./wall.js"`; at the start of `runAgent` add
```ts
  const wall = await loadWall();
  const cmd = wall.on ? wallCmd(agent.cmd, wall.allowed) : agent.cmd;
```
  and replace `agent.cmd` with `cmd` in the `needsFile`, `viaStdin` and `substituteCmd(agent.cmd, ...)` lines.
- [ ] Step 4: run `tests/invoke-sdk.test.ts tests/relay-wall.test.ts tests/relay-unit.test.ts tests/forge-runs.test.ts` and `npm run typecheck`; expect PASS. Commit: `Apply the agent wall in runAgent and the SDK lane`.

### Task 3: docs

- [ ] `docs/AGENT_CLIS.md` lane table (lines ~162-167): claude row: "Walled at launch: --restricted confines file tools to the working folder; only forge.allowedCommands run; prompt on stdin." sdk row: "acceptEdits + allowedTools from forge.allowedCommands; other Bash denied; Write/Edit confined to the sandbox." codex row: "--sandbox workspace-write added at launch." agy row: "Not confined by VibeOps (--sandbox unverified on Windows)." Commit: `Document the agent wall`.

### Controller live check

Through `runAgent` with the real claude.exe: reply works; allowed `npm test` in a scratch package runs; a disallowed `node -e` write to `../outside.txt` is refused and the file does not exist.
