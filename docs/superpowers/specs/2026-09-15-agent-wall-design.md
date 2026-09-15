# Agent wall: stop stray writes outside the sandbox

Date: 2026-09-15. Status: approved in chat ("complete the wall").

## Problem

Agents run as the user's Windows account. The work sandbox is a git worktree, not an OS boundary: an agent with auto-approve on (agy now runs `--dangerously-skip-permissions`) can edit or delete files anywhere the user can. The only backstop is the sentinel, which restores three files after the work stage (`src/forge/sentinel.ts`).

Threat in scope: stray WRITES outside the agent's working folder by an over-eager agent. Reads and network stay open (out of scope).

## Verified facts (this machine, 2026-09-15)

- `claude --restricted --permission-mode acceptEdits --permission-prompts none --model Sonnet -p` with the prompt on stdin answers normally.
- Same flags: a Write inside the working folder succeeded; a Write to `../outside.txt` was refused and the file does not exist.
- `--restricted` removes the code-running tools (Bash, PowerShell, REPL) unless `--tools` names them, ignores user/project/local settings files (`--settings` still applies), and confines the file tools to the working directories.
- Claude Code's own OS sandbox does not support native Windows.
- Agent SDK 0.1.77 supports `permissionMode`, `allowedTools`, `disallowedTools`, `settingSources`; allow rules are evaluated before `canUseTool`.
- agy `--sandbox`: behaviour on Windows NOT verified (the auto-mode classifier blocked the test). Excluded until verified.

## Decisions

- Walls are applied by VibeOps at launch, per program, regardless of the relay.json cmd. No relay.json migration. `forge.agentWall` = `"false"` turns it off.
- Allow-list default: `npm test`, `npm run`, `npx vitest`, `npx tsc`, `git status`, `git diff`, `git log`, `git show`. Overridable with `forge.allowedCommands` (JSON string array); malformed falls back to the default.
- Each allow-list entry becomes four Claude permission rules: `Bash(<c>)`, `Bash(<c> *)`, `PowerShell(<c>)`, `PowerShell(<c> *)`.

## Design

### `src/relay/wall.ts` (new)

- `DEFAULT_ALLOWED_COMMANDS`, `resolveAllowedCommands(setting)`, `allowRules(allowed)`.
- `wallCmd(cmd, allowed)`: pure. By the program basename of `cmd[0]`:
  - `claude`: if `--restricted` is already present, return unchanged. Otherwise drop every argument exactly equal to `{prompt}` or `{promptFile}` (the prompt then goes on stdin; a prompt file outside the working folder would be refused and claude treats file content as untrusted), ensure `-p` or `--print` is present (append `-p` if not), and append `--restricted --permission-mode acceptEdits --permission-prompts none --tools Read,Edit,Write,Glob,Grep,Bash,PowerShell --settings <{"permissions":{"allow":[...allowRules]}}>`.
  - `codex`: if the cmd has `exec` and no `--sandbox`, insert `--sandbox workspace-write` right after `exec`.
  - anything else: unchanged.
- `loadWall()`: reads `forge.agentWall` and `forge.allowedCommands` through `getSetting` (dynamic import, so callers without a database get the defaults: wall on, default allow-list).
- `binBasename` is exported from `src/relay/doctor.ts` and reused.

### `src/relay/invoke.ts`

`runAgent` computes `const cmd = wall.on ? wallCmd(agent.cmd, wall.allowed) : agent.cmd` first and uses `cmd` everywhere it used `agent.cmd` (prompt-file detection, stdin detection, placeholder substitution). Every CLI spawn (forge stages, council, chat, explain-diff, relay runner) passes through it.

### `src/relay/invoke-sdk.ts`

When the wall is on, `query()` gets `settingSources: []` and `allowedTools: allowRules(allowed)` (no acceptEdits, so every Write/Edit still reaches the realpath-aware guard). `checkToolPermission` gains a `walled` flag: a `Bash` call that reaches the callback (so no allow rule approved it) is denied and logged as `[forge: permission-denied Bash ...]`; with the wall off it is allowed as today.

### Docs

`docs/AGENT_CLIS.md` lane table: claude, sdk, codex rows describe the wall; agy row says not confined by VibeOps (`--sandbox` unverified).

## Testing

- `tests/relay-wall.test.ts`: `wallCmd` for the claude promptFile template, inline `{prompt}`, missing `-p`, already-walled (idempotent), codex insert, codex already sandboxed, agy and node unchanged; `allowRules`; `resolveAllowedCommands` valid, malformed, unset.
- `tests/invoke-sdk.test.ts`: `checkToolPermission` denies `Bash` when walled, allows it when not.
- Existing suites unchanged (fake agents run as `node`).
- Live check after implementation: through `runAgent`, walled claude answers a prompt, runs an allowed command (`npm test` in a scratch package), and refuses a disallowed write to `../outside.txt` (file must not exist).

## Out of scope

Reads, network, kimi/gemini walls, agy `--sandbox` (until verified), OS-level jails.
