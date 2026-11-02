# Ideas ported from jcode

jcode (github.com/1jehuang/jcode, MIT, Rust) is a coding agent harness built for running many agents at once. The owner asked to bring its useful ideas into VibeOps. This document records which ideas survive a gap check against the VibeOps code as of master `aa62904`, and what each one changes. Ideas are ported as designs in TypeScript; no jcode code is copied.

## Why

- Forge spend is partly guessed. Only the `claude-sdk` lane records exact tokens and cost. CLI lanes (`claude`, `agy`, `codex`) and `http` lanes record `(promptChars + outputChars) / 4` with cost 0 (`src/services/usage.ts`), so `spend-guard.mjs` multiplies CLI tokens by a flat rate, and the budget caps in `src/forge/runs.ts` mix exact and estimated numbers without knowing it.
- Agents can run dangerous shell commands. The allow-list wall (`src/relay/wall.ts`) covers only `claude` and `codex` command lines and the SDK permission callback. `agy` lanes run with `--dangerously-skip-permissions` and no wall. With `forge.agentWall` set to `false`, nothing blocks `git push`, `npm publish` or `rm -rf ..`. A prefix entry such as `npm run` also lets `npm run deploy` through. Protected paths and the sandbox sentinel only catch damage after it happens.
- Parallel Forge runs on one project only find that they touched the same files when the second one merges (`promoteSandbox`, `src/forge/sandbox.ts`), after all the work is done.
- Browser errors are matched by message text (`src/browser/refusal.ts`), so rewording a message in the extension silently breaks the friendly error. Agents also have no way to wait for a page to show something before reading it.

## Goals

1. Exact token counts for `claude` and `agy` CLI lanes, exact cost for `claude` lanes, and every usage row marked as exact or estimated.
2. A deny list of high-risk shell commands that applies to every lane VibeOps can control, whether the wall is on or off.
3. An early warning when two active runs in the same project plan to touch the same files.
4. Stable error codes and a `wait` step for the browser bridge.

## Non-goals

- Account routing changes. VibeOps already picks accounts by priority, skips exhausted ones, and Forge already retries a run on the next account after a usage limit (`src/forge/runs.ts` around line 601, "usage limit on account X, continuing on Y"). jcode's plan detection and hot swap rely on vendor login tokens or an interactive session, which VibeOps does not have.
- Session hibernation. VibeOps workers are short-lived CLI processes; there is nothing idle to shrink.
- Agent-to-agent messaging, coordinator roles, file locks, per-tool-call intent tracking. Forge stages are spawned only by the pipeline.
- jcode's usage delivery queue, receipts and replay window. VibeOps writes usage straight to its own database.
- A multi-provider browser abstraction, `eval`, full-page screenshots, back/forward/reload. One extension, and `eval` would break the closed step list.
- Adding jcode itself as a lane. RAM is not the current bottleneck, and it would need a binary installed on the owner's machine. Revisit if many parallel workers become the norm.
- Anything Gemini related (parked by the owner).

## Anti-goals

- No full shell parser. Regex rules per command segment are enough; mark the ceiling with a `ponytail:` comment (`$(...)`, `sh -c` and similar can evade it).
- Do not block or serialize runs on file overlap. Warn only.
- Do not lose the live Forge run log for lanes that do not opt into exact usage.
- Never print or log credential contents.

## The changes

### 1. Usage: exact or estimated

- `ai_usage_logs` gains a boolean `exact` column (drizzle migration after `0024`). `logAgentUse` sets it to `true` when the caller passes real `tokens`, `false` when it falls back to the estimate. Old rows stay `null`, meaning unknown.
- The AI usage view (`src/services/system.ts` usage query) and `spend-guard.mjs` split exact from estimated totals. spend-guard applies its flat CLI rate only to estimated rows, and uses recorded cost where the row is exact and has cost.
- `claude` CLI lanes: add `--output-format stream-json --verbose` when the lane opts in, and read the final `type:"result"` event for `total_cost_usd` and `usage` (same sum as `invoke-sdk.ts`). The text the agent writes must still reach the run log and `res.output` as readable text, live, not as raw JSON. Translate events to text as they are tailed.
- `agy` lanes: agy 1.4.12 supports `--output-format json` and `stream-json`. A test call with `json` returned one object: `{"status":"SUCCESS","response":"...","usage":{"input_tokens":28484,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":28485}}`. Use `total_tokens` as the exact token count; cost stays 0 (subscription). Same rule as above: the run log stays readable and live if `stream-json` allows it.
- If a lane opted in but no usage can be parsed (no final event, bad JSON, crash), the stage carries on exactly as today: tokens fall back to the estimate with `exact = false`. `res.output` is always the agent's plain text, as today, because the gate, reports and memory capture read it.
- The budget caps in `runs.ts` keep summing `tokens` as they do now. Opted-in lanes simply feed them better numbers.
- Opt-in per lane via a new optional `usage: "exact"` field on the lane in `relay.json` (validated in `src/relay/config.ts`), so a lane whose CLI changes its output can be switched back without a code change.
- `codex` and `http` lanes stay on the estimate in this round.

### 2. Command deny list

- New `src/relay/risk.ts`: a list of `[RegExp, reason]` rules and `commandRisk(cmd, workdir): string | null`. Split the command on `&&`, `||`, `;`, `|` and newlines, strip `sudo`, `env`, `timeout` and `nice` wrappers, test each segment.
- Starting rules: `git push`, `git remote add|set-url`, `git reset --hard origin`, `rm -r`/`-rf` whose target resolves outside the workdir (or is `/`, `~`, `$HOME`, `..`), `curl|wget ... | sh|bash`, `npm publish`, `npm run deploy|publish|release`, `vercel`, `gh pr|issue|release|repo`, `ssh`, `scp`, `docker push`, `dd of=`, `find ... -delete` outside the workdir.
- Every rule has a short id (`git-push`, `npm-publish`, `rm-outside`, ...). A ticket can lift one or more rules for its run with an `ALLOW-COMMAND: <id>[, <id>]` line, parsed like `ALLOW-PROTECTED` in `src/forge/policy.ts`. Unknown ids are ignored and logged.
- The workdir-aware rules (`rm-outside`, `find-delete-outside`) are exact only where VibeOps calls `commandRisk` itself (SDK lanes, agy hooks if available). `claude` CLI deny patterns are globs and cannot resolve paths, so on those lanes they block `rm -r`/`find -delete` whose target starts with `/`, `~`, `$HOME`, `..` or a drive letter, and allow relative targets. This over-blocks an absolute path inside the sandbox; accepted.
- Wire it in where VibeOps can act before the command runs:
  - SDK lanes: `checkToolPermission` (`src/relay/invoke-sdk.ts:37`) checks risk first, before the wall-off allow at line 46, and denies with the reason in the existing `[forge: permission-denied ...]` form.
  - `claude` CLI lanes: add matching `Bash(...)` and `PowerShell(...)` patterns to the deny rules (`src/relay/wall.ts`). Deny rules beat allow rules, so this holds even for allow-listed prefixes like `npm run`. `wallCmd` takes the ticket's lifted rule ids, builds the deny list per run without them, and passes the deny list even when the wall is off.
  - `agy` lanes: agy's changelog shows `hooks.json` hooks with tool matchers (`PostToolUse` exists), permission rules in settings, and a per-session `--settings` flag. Use a pre-tool hook that calls `commandRisk` (preferred, exact) or per-run deny settings. If neither works in agy 1.4.12, agy lanes keep running as today, each agy stage logs `forge: agy lane is not covered by the command deny list`, and `docs/AGENT_CLIS.md` says so.

### 3. File overlap warning

- When a run's plan is ready and before the work stage starts, collect its declared paths with `extractDeclaredPaths` (`src/forge/gate.ts:35`). Keep only entries containing `/` to avoid basename and token noise. Store them on the in-memory run.
- Compare with every other active run in the same project. "Active" means present in the server's in-memory run list (`activeRuns()`), which lives in the one VibeOps server process. A run reattached after a restart has no stored paths and is skipped; accepted. On overlap, append `forge: WARN plan overlaps ticket <short id> "<title>" on <files>` to the run log and post the same line as a ticket comment.
- Put the comparison in a pure helper so it can be tested without a run.

### 4. Browser bridge

- Extension errors gain an optional `code` next to `error`: `stale_ref`, `no_grant`, `origin_mismatch`, `navigation_timeout`, `unsupported_verb`, `screenshot_failed`, `wait_timeout`. `humanizeBrowserError` matches the code first and falls back to today's text rules, so old extension builds still work.
- New `wait` step: `{ verb: "wait", text: string }`. Add it to `SHAPES` and to the verb list in the error message (`src/browser/validate.ts`), to the `ActionStep` type (`src/browser/channel.ts`), and to the extension executor: poll the page text every 100 ms, give up after 10 s with `wait_timeout`. `wait` only reads the page, so it should need no act grant; follow how `read` and `snapshot` are gated today.
- The extension version number is bumped so the owner can tell the new build apart.

## Order

Each part ships and is reviewed on its own: 2 (deny list, highest risk reduction), then 1 (usage), then 3, then 4.

## Calls made by the designer (not decided by the owner)

- `ALLOW-COMMAND` lifts rules by id, per ticket.
- `claude` CLI lanes over-block absolute and parent-directory `rm -r` targets rather than miss them.
- If agy cannot take hooks or deny settings, agy lanes keep running uncovered with a log line, rather than being refused.
- Unparseable usage falls back to the estimate; it never fails a stage.
- Budget caps are unchanged.
- File overlap ignores runs reattached after a restart.

## Left to the builder

- Exact regex text for the deny rules, and the deny-rule syntax `claude` accepts for each pattern.
- How to translate `stream-json` events to log text for each CLI, and whether agy's `stream-json` carries usage in its last event or only `json` does. If agy can only report usage with buffered `json`, use `json` for agy lanes that opt in and note that their log appears at the end of each stage.
- Where in `runs.ts` the overlap check sits, as long as it runs after the plan and before the work stage.
- Test files and fixtures. Each part needs tests that fail without the change.

## Testing

- Each part: unit tests per the project's TDD rule, then `npx tsc --noEmit -p .` and the touched test files.
- Usage: one real `agy` call through the lane with `usage: "exact"`, checking that the `ai_usage_logs` row has `exact = true` and the agy token count.
- Deny list: an SDK-lane permission test and a `wallCmd` test proving `git push` and `npm run deploy` are denied with the wall on and off.
- Browser: the new `wait` step against a real page through the extension, once the owner reloads it.
- The change reaches the owner only after a VibeOps rebuild and reinstall; do not reinstall from a run.
