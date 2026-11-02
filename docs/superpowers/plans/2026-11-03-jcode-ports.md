# jcode ports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block high-risk agent shell commands on every lane VibeOps controls, record exact usage for `claude` and `agy` CLI lanes, warn on file overlap between parallel runs, and give the browser bridge error codes and a `wait` step.

**Architecture:** A pure rule module (`src/relay/risk.ts`) is consulted by an SDK PreToolUse hook (exact, path-aware) and turned into `claude` CLI deny globs. Opted-in CLI lanes run with `--output-format json`; a pure parser turns the final JSON into plain text plus usage, and `ai_usage_logs` gains an `exact` flag. The overlap warning and browser changes are small additions to existing modules.

**Tech Stack:** TypeScript (ESM, Node), Hono, drizzle-orm on PGlite/Postgres, vitest, Chrome MV3 extension (plain JS).

**Spec:** `docs/superpowers/specs/2026-11-03-jcode-ports-design.md`

## Global Constraints

- Work on branch `feat/jcode-ports` (create from `master`).
- No new dependencies. Plain ASCII, no emojis, minimal comments, style of the surrounding code.
- Mark the regex-not-a-shell-parser ceiling in `risk.ts` with a `ponytail:` comment.
- Never print or log credential contents.
- Run one test file: `VIBEOPS_TEST_EMBEDDED=1 node scripts/test-lane.mjs tests/<file>.test.ts`. Typecheck: `npx tsc --noEmit -p .`.
- Do not run `git push`. Commit per task with a plain message (no co-author lines).
- Nothing reaches the owner until VibeOps is rebuilt and reinstalled; never reinstall from a task.

## Review Focus

1. Wrapped and chained commands (`sudo git push`, `FOO=1 git push`, `cd .. && rm -rf x`) must be blocked: Task 1 tests.
2. Benign lookalikes must pass (`echo "git push"`, `grep -r "rm -rf /" src`, `rm -rf node_modules/.cache`, `npm run test`): Task 1 tests.
3. Windows paths: workdir `C:\w\sb`, `rm -rf C:\Users` blocked, `rm -rf .\build` allowed, case-insensitive match: Task 1 tests.
4. JSON output that is truncated, garbled, or preceded by a stderr warning line must fall back or keep the warning: Task 6 tests.
5. Lifting one rule id must not lift any other, and unknown ids are ignored: Task 1 tests.

---

## Part A: command deny list

### Task 1: Risk rules and the ALLOW-COMMAND parser

**Files:**
- Create: `src/relay/risk.ts`
- Modify: `src/forge/policy.ts` (add `parseAllowCommand` after `parseAllowFiles`)
- Test: `tests/relay-risk.test.ts`, `tests/forge-policy.test.ts`

**Interfaces:**
- Produces:
  - `export type RiskHit = { id: string; reason: string }`
  - `export const RISK_IDS: readonly string[]` (every rule id)
  - `export function commandRisk(cmd: string, workdir: string, lifted: readonly string[] = []): RiskHit | null`
  - `export function denyPatterns(lifted: readonly string[] = []): string[]` (claude CLI permission globs, `Bash(...)` and `PowerShell(...)` for each)
  - `export function parseAllowCommand(body: string): string[]` in `policy.ts`

Rules (id: what blocks, CLI globs). Segment rules test each segment after splitting; `curl-pipe` tests the whole command before splitting.

| id | blocks | CLI globs (each emitted as `Bash(g)` and `PowerShell(g)`) |
|---|---|---|
| `git-push` | `git push ...` | `git push*` |
| `git-remote` | `git remote add|set-url ...` | `git remote add*`, `git remote set-url*` |
| `git-reset-origin` | `git reset --hard <x>origin<y>` | `git reset --hard origin*` |
| `rm-outside` | `rm` with a recursive flag (`-r`, `-R`, `-rf`, `-fr`, `-Rf`, `--recursive`) and any target resolving outside the workdir, or equal to it | `rm <f> <t>*` for f in `-r -R -rf -fr -Rf`, t in `/ ~ .. $HOME C: D:` |
| `find-delete-outside` | `find <path> ... -delete` where path resolves outside the workdir | `find /* -delete*`, `find ~* -delete*`, `find ..* -delete*` |
| `curl-pipe` | `curl|wget ... | [sudo] sh|bash|zsh|pwsh|powershell` | `curl *| sh*`, `curl *| bash*`, `wget *| sh*`, `wget *| bash*` |
| `npm-publish` | `npm publish` | `npm publish*` |
| `npm-deploy` | `npm run deploy|publish|release` | `npm run deploy*`, `npm run publish*`, `npm run release*` |
| `vercel` | `vercel ...`, `npx vercel ...` | `vercel*`, `npx vercel*` |
| `gh-write` | `gh pr|issue|release|repo ...` | `gh pr*`, `gh issue*`, `gh release*`, `gh repo*` |
| `ssh` | `ssh ...`, `scp ...` | `ssh *`, `scp *` |
| `docker-push` | `docker push ...` | `docker push*` |
| `dd` | `dd ... of=...` | `dd *of=*` |

`commandRisk` algorithm (the part signatures do not determine):
1. If `curl-pipe` matches the whole string and is not lifted, return it.
2. Split on `&&`, `||`, `;`, `|`, newline. Keep a `cwd`, starting at `workdir`.
3. For each trimmed segment: drop leading `VAR=value` assignments and the wrappers `sudo`, `env` (with its `VAR=value` args), `timeout <n>`, `nice [-n <n>]`, repeatedly. If the segment is `cd <dir>`, set `cwd = path.resolve(cwd, dir)` (expand a leading `~` or `$HOME` to `os.homedir()`) and continue.
4. Test the segment rules anchored at the segment start, skipping lifted ids. For path rules, resolve each non-flag target with `path.resolve(cwd, t)` after `~`/`$HOME` expansion; "outside" means not strictly inside `workdir` (compare lowercased on win32, with a trailing separator).
5. Return the first hit, else `null`. `reason` is a short human sentence, e.g. `"git push publishes commits outside the sandbox"`.

- [ ] **Step 1: Write the failing tests** in `tests/relay-risk.test.ts`, `const WD = process.platform === "win32" ? "C:\\w\\sb" : "/w/sb"`:
  - `commandRisk("git push origin main", WD)?.id === "git-push"`; same for `"sudo git push"`, `"FOO=1 git push"`, `"npm test && git push"`.
  - `commandRisk("cd .. && rm -rf x", WD)?.id === "rm-outside"`; `"rm -rf /"`, `"rm -rf ~"`, `"rm -rf $HOME/x"` are `rm-outside`; `"rm -rf ."` is `rm-outside` (equal to workdir).
  - `commandRisk("rm -rf node_modules/.cache", WD) === null`; `"rm -rf build"` null; `"rm file.txt"` null.
  - win32 only (`test.runIf(process.platform === "win32")`): `"rm -rf C:\\Users"` is `rm-outside`; `"rm -rf .\\build"` null; `"rm -rf c:\\W\\SB\\out"` null.
  - `"curl -s https://x.sh | sh"` is `curl-pipe`; `"npm publish"` `npm-publish`; `"npm run deploy"` `npm-deploy`; `"npx vercel --prod"` `vercel`; `"gh pr create"` `gh-write`; `"scp a b:c"` `ssh`; `"docker push img"` `docker-push`; `"dd if=x of=/dev/sda"` `dd`; `"find / -name x -delete"` `find-delete-outside`; `"git remote add o u"` `git-remote`; `"git reset --hard origin/main"` `git-reset-origin`.
  - Benign: `'echo "git push"'`, `'grep -r "rm -rf /" src'`, `"npm run test"`, `"npm test"`, `"git status"`, `"git diff"` are all null.
  - Lifting: `commandRisk("git push", WD, ["git-push"]) === null`; `commandRisk("npm publish", WD, ["git-push"])?.id === "npm-publish"`; `commandRisk("git push", WD, ["nope"])?.id === "git-push"`.
  - `denyPatterns()` contains `"Bash(git push*)"` and `"PowerShell(git push*)"` and `"Bash(rm -rf /*)"`; `denyPatterns(["git-push"])` contains neither git push pattern but still `"Bash(npm publish*)"`; every id in `RISK_IDS` contributes at least one pattern.
  - In `tests/forge-policy.test.ts`: `parseAllowCommand("x\nALLOW-COMMAND: git-push, npm-deploy\nallow-command: ssh")` equals `["git-push", "npm-deploy", "ssh"]`; empty body gives `[]`.
- [ ] **Step 2: Run, expect FAIL** (module not found): `VIBEOPS_TEST_EMBEDDED=1 node scripts/test-lane.mjs tests/relay-risk.test.ts tests/forge-policy.test.ts`
- [ ] **Step 3: Implement** `risk.ts` per the table and algorithm, and `parseAllowCommand` mirroring `parseAllowFiles` with `/^\s*ALLOW-COMMAND:\s*(.+)$/gim`.
- [ ] **Step 4: Run, expect PASS**, then `npx tsc --noEmit -p .`
- [ ] **Step 5: Commit** `feat(relay): command risk rules and ALLOW-COMMAND parser`

### Task 2: SDK lane hook and lifted rules from the ticket

**Files:**
- Modify: `src/relay/config.ts:14,25` (call-time field), `src/relay/invoke-sdk.ts:87-110,127-141`, `src/forge/runs.ts:827`
- Test: `tests/invoke-sdk.test.ts`

**Interfaces:**
- Consumes: `commandRisk`, `parseAllowCommand` (Task 1).
- Produces:
  - `RelayAgent.liftedRules?: string[]` (call-time only, like `write` and `addDirs`; extend the line-14 comment).
  - `export function riskHook(workdir: string, lifted: readonly string[], onData?: (chunk: string) => void): HookCallback` in `invoke-sdk.ts`.
  - `buildSdkOptions(env, workdir, wallOn, allowed, onData?, model?, lifted: readonly string[] = [])`.

- [ ] **Step 1: Write the failing tests** in `tests/invoke-sdk.test.ts`:
  - `await riskHook(dir, [])({ tool_name: "Bash", tool_input: { command: "git push" } } as any, undefined, { signal } as any)` returns `hookSpecificOutput.permissionDecision === "deny"` and `permissionDecisionReason` containing `git-push`; the `onData` spy received a chunk starting `"\n[forge: permission-denied Bash git push"`.
  - Same call with `tool_name: "PowerShell"` also denies.
  - `command: "npm test"` returns `{}`; `riskHook(dir, ["git-push"])` with `git push` returns `{}`.
  - `buildSdkOptions({}, dir, false, []).hooks.PreToolUse[0].hooks` has length 2 (background hook plus risk hook).
- [ ] **Step 2: Run, expect FAIL**: `VIBEOPS_TEST_EMBEDDED=1 node scripts/test-lane.mjs tests/invoke-sdk.test.ts`
- [ ] **Step 3: Implement.** `riskHook` reads `tool_input.command` for `Bash`/`PowerShell`, calls `commandRisk(command, workdir, lifted)`, and on a hit writes `\n[forge: permission-denied Bash <command first 120 chars> (<id>)]\n` to `onData` and returns `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: \`blocked by the forge deny list (${id}): ${reason}\` } }`. Add it after `denyBackground` in `buildSdkOptions`. `runAgentSdk` passes `agent.liftedRules ?? []`. In `runs.ts` the work-stage `runAgent({ ...agents.work, write: true, ... })` call adds `liftedRules: parseAllowCommand(ticket.body ?? "")`; plan and review stages get nothing.
- [ ] **Step 4: Run, expect PASS**; also run `tests/forge-sdk-lane.test.ts` and `tests/forge-sdk-runs.test.ts`; `npx tsc --noEmit -p .`
- [ ] **Step 5: Commit** `feat(relay): deny high-risk commands on sdk lanes`

### Task 3: claude CLI deny globs, wall on and off

**Files:**
- Modify: `src/relay/wall.ts:20-47`, `src/relay/invoke.ts:114-115`
- Test: `tests/relay-wall.test.ts`

**Interfaces:**
- Consumes: `denyPatterns` (Task 1), `RelayAgent.liftedRules` (Task 2).
- Produces:
  - `wallCmd(cmd, allowed, write = false, addDirs = [], lifted: readonly string[] = [])` puts `deny: [...DENY_RULES, ...denyPatterns(lifted)]` in its `--settings`.
  - `export function denyOnlyCmd(cmd: string[], lifted: readonly string[] = []): string[]`: for a `claude` binary whose cmd has no `--settings`, appends `["--settings", JSON.stringify({ permissions: { deny: [...DENY_RULES, ...denyPatterns(lifted)] } })]`; any other cmd is returned unchanged.

- [ ] **Step 1: Update and add tests** in `tests/relay-wall.test.ts`:
  - Change the top `SETTINGS` constant to use `deny: [...DENY_RULES, ...denyPatterns([])]` so existing claude tests expect the longer list.
  - `wallCmd(["claude","-p"], ["npm run"], false, [], ["git-push"])`: the parsed `--settings` deny list lacks `Bash(git push*)` but has `Bash(npm run deploy*)`.
  - `denyOnlyCmd(["claude","-p"])` ends with `--settings` and a JSON whose `permissions.deny` contains `Bash(git push*)` and has no `allow` key.
  - `denyOnlyCmd(["claude","-p","--settings","{}"])` and `denyOnlyCmd(["codex","exec"])` are returned unchanged.
- [ ] **Step 2: Run, expect FAIL**: `VIBEOPS_TEST_EMBEDDED=1 node scripts/test-lane.mjs tests/relay-wall.test.ts`
- [ ] **Step 3: Implement**, and in `invoke.ts` change line 115 to `wall.on ? wallCmd(agent.cmd, wall.allowed, agent.write === true, agent.addDirs, agent.liftedRules) : denyOnlyCmd(agent.cmd, agent.liftedRules)`. Update the `wallCmd` comment to say claude also gets the deny list when the wall is off.
- [ ] **Step 4: Run, expect PASS**; also `tests/relay-unit.test.ts`; `npx tsc --noEmit -p .`
- [ ] **Step 5: Commit** `feat(relay): claude cli lanes get the deny list with the wall on or off`

### Task 4: agy coverage (controller spike, then one small task)

Done by the controller, not a cheap implementer, because the agy settings format must be discovered first.

- [ ] **Step 1:** Check agy 1.4.12's documented settings and hooks (`agy help`, `agy changelog`, `~/.gemini/antigravity-cli/builtin` docs only; never open auth or credential files) for (a) a pre-tool hook event that receives the shell command and can deny, or (b) permission deny rules accepted through `--settings`.
- [ ] **Step 2:** In a scratch folder, run one cheap `agy --model gemini-3.8-flash-low -p` call with the candidate per-run setting, prompting it to run `git push --dry-run`, and confirm it is refused.
- [ ] **Step 3a (works):** write a one-task addendum to this plan in the Task 3 shape: `agyDenyCmd(cmd, lifted)` in `wall.ts`, called for agy cmds in `invoke.ts` on both wall paths, with a `relay-wall` test. Dispatch it.
- [ ] **Step 3b (does not work):** in `invoke.ts`, when `laneKind(agent) === "agy"`, emit `\n[forge: agy lane is not covered by the command deny list]\n` through `onData` once per stage, with a test in `tests/relay-unit.test.ts` using a fake cmd named `agy`; add one paragraph to `docs/AGENT_CLIS.md`.

### Task 4 addendum (spike result): agy per-run deny rules

Spike result: agy 1.4.12 reads `permissions.deny` from settings, and `--settings` takes the same keys inline for one session. Rules use `command(<token prefix>)` or `command(regex:<pattern>)`, where each whitespace-separated token is matched as an anchored regex. Per https://antigravity.google/docs/permissions, deny rules take precedence over `--dangerously-skip-permissions`. A live check was blocked by the controller's auto mode and is deferred to after reinstall.

**Files:**
- Modify: `src/relay/risk.ts` (add `agyPatterns`), `src/relay/wall.ts` (add `agyDenyCmd`), `src/relay/invoke.ts` (apply on both wall paths), `docs/AGENT_CLIS.md` (one paragraph)
- Test: `tests/relay-risk.test.ts`, `tests/relay-wall.test.ts`

**Interfaces:**
- Produces: `export function agyPatterns(lifted: readonly string[] = []): string[]` in `risk.ts`; `export function agyDenyCmd(cmd: string[], lifted: readonly string[] = []): string[]` in `wall.ts`.

agy patterns per rule id. Rules with no agy form are left out and named in the doc paragraph. The patterns are exact strings; the backslashes are literal regex escapes.

- `git-push`: `command(git push)`
- `git-remote`: `command(git remote add)`, `command(git remote set-url)`
- `git-reset-origin`: `command(regex:git reset --hard origin.*)`
- `rm-outside`: `command(regex:rm -[a-zA-Z]*[rR][a-zA-Z]* (/|~|\.\.|\$HOME|[A-Za-z]:).*)`
- `npm-publish`: `command(npm publish)`
- `npm-deploy`: `command(npm run deploy)`, `command(npm run publish)`, `command(npm run release)`
- `vercel`: `command(vercel)`, `command(npx vercel)`
- `gh-write`: `command(gh pr)`, `command(gh issue)`, `command(gh release)`, `command(gh repo)`
- `ssh`: `command(ssh)`, `command(scp)`
- `docker-push`: `command(docker push)`
- `dd`: `command(dd)`
- `find-delete-outside`, `curl-pipe`: none (token-prefix rules cannot express them)

- [ ] **Step 1: Write the failing tests.**
  - `agyPatterns()` contains `"command(git push)"` and `"command(npm run deploy)"`; `agyPatterns(["git-push"])` lacks `"command(git push)"`.
  - `agyDenyCmd(["C:\\x\\agy.exe","--model","m"])` ends with `"--settings"` and a JSON whose `permissions.deny` equals `agyPatterns()`.
  - `agyDenyCmd([... , "--settings", "{}"])` is unchanged; `agyDenyCmd(["claude","-p"])` is unchanged.
- [ ] **Step 2: Run, expect FAIL**: `VIBEOPS_TEST_EMBEDDED=1 node scripts/test-lane.mjs tests/relay-risk.test.ts tests/relay-wall.test.ts`
- [ ] **Step 3: Implement.** `agyDenyCmd` applies only when `binBasename(cmd[0]).toLowerCase() === "agy"`. In `invoke.ts`, after the line from Task 3, set `cmd = agyDenyCmd(cmd, agent.liftedRules)` on both wall paths (make `cmd` a `let`). In `docs/AGENT_CLIS.md`, add a paragraph: agy lanes get the deny list as per-run `--settings` permission rules, and `find-delete-outside` and `curl-pipe` are not covered on agy.
- [ ] **Step 4: Run, expect PASS**; `npx tsc --noEmit -p .`
- [ ] **Step 5: Commit** `feat(relay): agy lanes get the deny list as per-run permission rules`

## Part B: exact usage

### Task 5: `exact` column and estimated totals

**Files:**
- Modify: `src/db/schema.ts:155-164`, `src/services/usage.ts:30-44`, `src/services/system.ts:85-90`
- Create: generated `drizzle/0025_*.sql`, snapshot and journal entry via `npm run db:generate -- --name usage_exact`
- Test: `tests/usage-writers.test.ts`

**Interfaces:**
- Produces: `aiUsageLogs.exact` (`boolean('exact')`, nullable); `getAiUsage().usage[i].estimatedTokens: number` (sum of tokens where `exact` is not true).

- [ ] **Step 1: Write the failing tests** in `tests/usage-writers.test.ts`:
  - Extend `"logAgentUse writes real tokens and cost when provided"`: `expect(row.exact).toBe(true)`.
  - New `"logAgentUse marks estimated rows"`: no `tokens`, `promptChars: 400, outputChars: 400` gives `row.tokens === 200` and `row.exact === false`.
  - New `"getAiUsage splits estimated tokens"`: one exact row (tokens 1000) and one estimated row (promptChars 400, outputChars 0, so 100 tokens) for a unique provider; that provider's usage entry has `tokens === 1100` and `estimatedTokens === 100`.
- [ ] **Step 2: Run, expect FAIL**: `VIBEOPS_TEST_EMBEDDED=1 node scripts/test-lane.mjs tests/usage-writers.test.ts`
- [ ] **Step 3: Implement.** Add the column, generate the migration (expected SQL: `ALTER TABLE "ai_usage_logs" ADD COLUMN "exact" boolean;`), set `exact: entry.tokens !== undefined` in `logAgentUse`, and add to `usageStats`: `estimatedTokens: sql<number>\`cast(coalesce(sum(case when ${aiUsageLogs.exact} is true then 0 else ${aiUsageLogs.tokens} end), 0) as integer)\``. Update the `UsageEntry` comment that says headless CLIs never report usage.
- [ ] **Step 4: Run, expect PASS**; also `tests/usage-estimate.test.ts` and `tests/system-api.test.ts`; `npx tsc --noEmit -p .`
- [ ] **Step 5: Commit** `feat(usage): mark exact vs estimated usage rows`

### Task 6: JSON usage for opted-in claude and agy lanes

**Files:**
- Create: `src/relay/usage-json.ts`
- Modify: `src/relay/config.ts` (type and validation), `src/relay/invoke.ts:114-116,228-237` and the `finish` closure
- Test: `tests/relay-usage-json.test.ts` (new), `tests/relay-unit.test.ts`

**Interfaces:**
- Produces:
  - `export function parseUsageJson(raw: string): { text: string; usage: { tokens: number; cost: number } } | undefined`
  - `RelayAgent.usage?: "exact"`

`parseUsageJson`: walk lines from the end; the first line that starts with `{` and parses decides.
- claude shape `{ type: "result", result, total_cost_usd, usage }`: text `result ?? ""`, tokens `input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens` (missing = 0), cost `Math.round((total_cost_usd ?? 0) * 1e6)`.
- agy shape `{ response: string, usage: { total_tokens: number } }`: text `response`, tokens `total_tokens`, cost `0`.
- Any other shape, or no parseable line: `undefined`.
- Lines before the JSON line are kept: `text = prefix ? prefix + "\n" + parsedText : parsedText`, where `prefix` is those lines joined and trimmed.

- [ ] **Step 1: Write the failing tests.**
  - `tests/relay-usage-json.test.ts`:
    - claude line `{"type":"result","result":"done","total_cost_usd":0.0123,"usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":3,"cache_read_input_tokens":2}}` gives `{ text: "done", usage: { tokens: 20, cost: 12300 } }`.
    - The exact agy line from the spec gives `{ text: "pong\n", usage: { tokens: 28485, cost: 0 } }`.
    - `"warning: x\n" + claudeLine` gives text `"warning: x\ndone"`.
    - Truncated `{"type":"result","res`, plain `"hello"`, and `{"foo":1}` all give `undefined`.
  - `tests/relay-unit.test.ts`:
    - `runAgent` with `{ cmd: [process.execPath, script], roles: ["work"], usage: "exact" }`, where `script` is a temp `.mjs` that prints the claude line to stdout: `res.usage` equals `{ tokens: 20, cost: 12300 }`, `res.output === "done"`, and the `onData` chunks joined equal `"done"`.
    - The same with a script printing `garbage`: `res.usage` is undefined and `res.output` contains `garbage`.
    - The same with no `usage` field: `onData` receives the raw JSON as today.
  - Config tests (in `tests/relay-unit.test.ts` next to the other `validateRelayConfig` cases, or a new `tests/relay-config-usage.test.ts`): `usage: "exact"` on `cmd: ["claude","-p"]` and on `cmd: ["C:\\x\\agy.exe"]` loads; on `cmd: ["codex","exec"]`, on `type: "sdk"`, and `usage: "yes"` each throw a message containing `usage`.
- [ ] **Step 2: Run, expect FAIL**: `VIBEOPS_TEST_EMBEDDED=1 node scripts/test-lane.mjs tests/relay-usage-json.test.ts tests/relay-unit.test.ts`
- [ ] **Step 3: Implement.**
  - Config: valid only when the value is `"exact"`, the lane is not `sdk` or `http`, and `laneKind` is `claude` or `agy`. Error: `relay config agent "<name>" usage "exact" is only supported on claude and agy cli lanes`.
  - `invoke.ts`:
    - After the cmd line from Task 3, when `agent.usage === "exact"` and `laneKind(agent)` is `claude` or `agy` and the cmd has no `--output-format`, append `"--output-format", "json"`.
    - In the spawn promise, when `agent.usage === "exact"`, `push` stores without calling `onData`, and the raw store cap is `OUTPUT_CAP * 4`.
    - In `finish`, run `parseUsageJson(output)`. Parsed: call `onData(text)` and resolve `{ ok, output: text.slice(0, OUTPUT_CAP), usage }`. Not parsed: call `onData(output)` and resolve as today.
    - Mark the raw run log file keeping JSON with a `ponytail:` comment.
- [ ] **Step 4: Run, expect PASS**; also `tests/relay-wall.test.ts`; `npx tsc --noEmit -p .`
- [ ] **Step 5: Commit** `feat(relay): exact usage from claude and agy json output`

### Task 7: spend-guard and lane opt-in (controller, outside the repo)

- [ ] Edit `~/.vibeops/scripts/spend-guard.mjs`: snapshot `estimatedTokens` too, and apply `CLI_RATE_PER_M` to the `estimatedTokens` delta of `claude*` keys, adding recorded cost deltas for every key. Never print the credentials it reads.
- [ ] After the owner rebuilds and reinstalls, propose adding `"usage": "exact"` to the `agy` and `claude` lanes in `~/.vibeops/relay.json` (owner confirms; back up first as `relay.json.bak-<date>-usage`).

## Part C: file overlap warning

### Task 8: Warn when active runs plan the same files

**Files:**
- Modify: `src/forge/gate.ts` (after `extractDeclaredPaths`), `src/forge/runs.ts:116-150` (Run type, RunSummary omit list) and just before `selectSkills(plan, ...)` (around line 785)
- Test: `tests/forge-gate.test.ts`

**Interfaces:**
- Produces:
  - `export function declaredFullPaths(planText: string): string[]`: `extractDeclaredPaths` entries containing `/`, sorted.
  - `export function overlappingDeclared(mine: readonly string[], others: readonly { ticketId: string; title: string; declared: readonly string[] }[]): { ticketId: string; title: string; files: string[] }[]`: one entry per other with a non-empty intersection, files sorted.
  - `Run` gains `projectId?: string; title?: string; declared?: string[]` (memory only; add `"declared"` to the `RunSummary` Omit list).

- [ ] **Step 1: Write the failing tests** in `tests/forge-gate.test.ts`:
  - `declaredFullPaths("Edit src/a.ts and b.ts, see e.g. docs/x.md")` equals `["docs/x.md", "src/a.ts"]`.
  - `overlappingDeclared(["src/a.ts","src/b.ts"], [{ ticketId: "t1", title: "One", declared: ["src/b.ts","src/c.ts"] }, { ticketId: "t2", title: "Two", declared: ["src/z.ts"] }])` equals `[{ ticketId: "t1", title: "One", files: ["src/b.ts"] }]`.
  - Basename-only overlap (`["a.ts"]` vs `["src/a.ts"]`) gives `[]`.
- [ ] **Step 2: Run, expect FAIL**: `VIBEOPS_TEST_EMBEDDED=1 node scripts/test-lane.mjs tests/forge-gate.test.ts`
- [ ] **Step 3: Implement** the helpers. In the pipeline, right before `const selectedSkills = selectSkills(...)`:
  - Set `run.projectId = ticket.projectId`, `run.title = ticket.title`, `run.declared = declaredFullPaths(plan)`.
  - Compute overlaps against `activeRuns()` entries with a different id, the same `projectId`, and a `declared` list.
  - For each overlap, build the line `forge: WARN plan overlaps ticket <first 8 chars of ticketId> "<title>" on <files joined by ", ">`. Pass it to `append(run, "\n" + line + "\n")` and to `addComment(actorId, ticket.id, line, "comment").catch(() => {})`.
- [ ] **Step 4: Run, expect PASS**; also `tests/forge-runs.test.ts` and `tests/forge-gate-runs.test.ts`; `npx tsc --noEmit -p .`
- [ ] **Step 5: Commit** `feat(forge): warn when parallel runs plan the same files`

## Part D: browser bridge

### Task 9: Error codes

**Files:**
- Modify: `extension/execute.js` (every `{ ok: false, error }`), `extension/worker.js:150-160,210,229,277-296`, `src/browser/channel.ts:27-30` (`BatchResult` result gains `code?: string`), `src/browser/refusal.ts`, callers in `src/mcp/server.ts:161-162,224-225` and `src/chat/tools.ts:59,197`
- Test: `tests/browser-refusal.test.ts`, `tests/extension-execute.test.ts`

**Interfaces:**
- Produces: `humanizeBrowserError(raw: string | undefined, code?: string): string`. Codes: `no_grant`, `origin_mismatch`, `navigation_timeout`, `stale_ref`, `unsupported_verb`, `screenshot_failed`, `out_of_viewport`, `no_element`, `no_page`, `page_navigated`, `wait_timeout` (Task 10).

- [ ] **Step 1: Write the failing tests.**
  - `tests/browser-refusal.test.ts`: for each code, `humanizeBrowserError("totally reworded text", code)` equals the message today's text rule yields for the matching original text. New codes without a text rule get a short plain sentence. An unknown code falls back to the text rules.
  - `tests/extension-execute.test.ts`: a stale `read` ref gives `results[0].code === "stale_ref"`; a mutating step without a grant gives `"no_grant"`; an unknown verb gives `"unsupported_verb"`.
- [ ] **Step 2: Run, expect FAIL**: `VIBEOPS_TEST_EMBEDDED=1 node scripts/test-lane.mjs tests/browser-refusal.test.ts tests/extension-execute.test.ts`
- [ ] **Step 3: Implement.** Add `code` next to every existing `error` in the extension, keeping the `error` text unchanged so older servers still work. `humanizeBrowserError` checks a `CODES` map first, then the existing `RULES`. Callers that hold a step result pass `step?.code` or `failed.code`.
- [ ] **Step 4: Run, expect PASS**; also `tests/mcp-browser.test.ts` and `tests/browser.test.ts`; `npx tsc --noEmit -p .`
- [ ] **Step 5: Commit** `feat(browser): stable error codes`

### Task 10: `wait` step

**Files:**
- Modify: `src/browser/validate.ts` (SHAPES and the verb list in the unknown-verb error), `src/browser/channel.ts` (`ActionStep`), `extension/execute.js` (new branch before the unsupported fallback), `extension/manifest.json` (`version` to `0.1.10`), the `browser_act` step description in `src/mcp/server.ts` if it lists verbs
- Test: `tests/browser-validate.test.ts`, `tests/extension-execute.test.ts`

**Interfaces:**
- Produces: `{ verb: "wait"; text: string }` step; `export const WAIT_TUNING = { timeoutMs: 10000, pollMs: 100 }` in `execute.js`.

- [ ] **Step 1: Write the failing tests.**
  - `validateSteps([{ verb: "wait", text: "Done" }])` is ok.
  - `{ verb: "wait" }` fails with `wait.text must be a string`.
  - The unknown-verb error lists `wait`.
  - jsdom: with `WAIT_TUNING.timeoutMs = 300`, a document whose body gains the text `Done` after 50 ms gives `{ ok: true }`. A document that never shows it gives `{ ok: false, code: "wait_timeout" }`. `wait` needs no act grant.
- [ ] **Step 2: Run, expect FAIL**: `VIBEOPS_TEST_EMBEDDED=1 node scripts/test-lane.mjs tests/browser-validate.test.ts tests/extension-execute.test.ts`
- [ ] **Step 3: Implement.**
  - Poll `doc.body?.innerText ?? doc.body?.textContent` for `step.text` every `pollMs` until `timeoutMs`.
  - On timeout, error text is `text "<text>" did not appear within 10s`, plus the code.
  - Rebuild `refMap` after a successful wait, since the page may have changed.
  - Do not add `wait` to `MUTATING` in `browser-routes.ts`.
- [ ] **Step 4: Run, expect PASS**; `npx tsc --noEmit -p .`
- [ ] **Step 5: Commit** `feat(browser): wait step`

## Finish

- [ ] Whole-branch review on the best model, all Critical and Important findings fixed.
- [ ] Full suite: `VIBEOPS_TEST_EMBEDDED=1 node scripts/test-lane.mjs`. Compare against master's known failures, and report new failures only.
- [ ] Merge to `master` locally. The owner's standing git authorization covers merge and push in this repo; confirm with the owner before pushing.
