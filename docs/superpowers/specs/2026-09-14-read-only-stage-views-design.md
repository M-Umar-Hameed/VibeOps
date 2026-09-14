# Read-only stage views: plan, review and explain-diff run in throwaway worktrees

Date: 2026-09-14. Status: approved in chat, pending spec review.

## Problem

Only the forge work stage runs in the ticket sandbox. Plan (`src/forge/runs.ts:591`), review (`runs.ts:839`) and explain-diff (`src/api/forge-routes.ts:322`) run with the REAL project folder as their working directory. The only thing stopping a planner or reviewer from editing the user's code is prompt text (`PLAN_ONLY`, `runs.ts:91`), and that has already failed once ("claude acceptEdits implemented during planning", `runs.ts:89-90`).

## Decisions

- Scope: forge plan, forge review, explain-diff. Chat and council stay in the relay.json `workdir` (no ticket, no sandbox).
- Mechanism: a throwaway detached git worktree ("view") per stage invocation, deleted when the stage ends. Rejected alternative: running plan/review inside the ticket sandbox itself, because checks run concurrently with review in that tree (`runs.ts:826`) and their outputs would be indistinguishable from reviewer edits.
- Stray edits (any change `git status --porcelain` reports in the view after the agent returns) are always discarded by deleting the view. Plan: warn in the run log and continue. Review: fail the stage with run status `failed` (not `rejected`, so recovery offers resume-to-review instead of a work rerun). Explain-diff: discard silently, still return the summary.
- claude-sdk stays work-only. The loader rule (`src/relay/config.ts:98-100`) and the three role-repair paths are unchanged. The Agents card makes this visible instead of hiding it (see UI below).

## Design

### `withReadOnlyView` (src/forge/sandbox.ts)

```ts
export async function withReadOnlyView<T>(
  workdir: string, ticketId: string, stage: "plan" | "review" | "explain", ref: string,
  fn: (viewPath: string) => Promise<T>,
): Promise<{ result: T; strayPaths: string[] }>
```

1. Path: `<sandboxRoot>/views/<ticketId>-<stage>-<8 hex random>`. The random suffix lets concurrent calls for the same ticket and stage coexist. The `views` dir is not UUID-named, so `listSandboxTicketIds` and the ticket sweep ignore it.
2. `git -C <workdir> worktree add --detach <path> <ref>` via the existing arg-vector `must` helper. Failure throws with git's message.
3. Run `fn(path)`.
4. `git status --porcelain` in the view, parsed to a path list (`strayPaths`).
5. In `finally`: `git worktree remove --force <path>`, then `rmSync(path, { recursive: true, force: true })` if it still exists, then `git worktree prune`. Removal errors are swallowed; the sweep reclaims leftovers. Views never get deps links (`linkDeps` is not called), so the recursive delete cannot traverse into the base repo.

If `fn` throws, removal still runs and the error propagates (no `strayPaths` in that case).

### Callers

| Caller | ref | On `strayPaths.length > 0` |
|---|---|---|
| Plan, `runs.ts:591` | `"HEAD"` (project HEAD) | `append(run, "[forge: planner changed files in its read-only copy; discarded: <paths>]")`, continue |
| Review, `runs.ts:836-847` (one view for all chunks) | `branchName(ticket.id)` | `bounce(run, actorId, "reviewer changed files in its read-only copy", <paths>)`, `settle(run, "failed")` |
| Explain-diff, `forge-routes.ts:322` | `branchName(ticketId)` | ignore |

Review check order: after the existing `reviewFailure` check and stop check, before verdict merging. Checks, the mechanical gate and all `sandbox*` git queries keep their current directories.

Comment updates only where they become false: `runs.ts:89-90` (plan/review now run in a throwaway copy; `PLAN_ONLY` prompt text stays as defence in depth) and `runs.ts:821-823` (reviewer runs in a view, not the workdir).

Behaviour change to note in the PR: the planner now sees the project's last commit, not uncommitted edits in the real folder. The work stage already works this way.

### Sweep

`cleanupMergedSandboxes` (`runs.ts:286`) additionally deletes `views/*` dirs whose mtime is older than 24 hours (`rmSync` recursive; safe for the same no-links reason), then relies on its existing per-workdir `pruneWorktreeRegistrations`. ponytail: age-based, since views have no owner record; a live-view registry is the upgrade path if a stage ever runs longer than 24 hours.

### UI: claude-sdk role checkboxes (app/src/components/settings/AgentsConfigCard.tsx)

For `agent.type === "sdk"` (`workOnly`), render all three role checkboxes (`plan`, `work`, `review`) instead of only `work`. All three are `disabled`, `work` is always checked, `plan`/`review` always unchecked, each with `title="The SDK lane runs the work stage only"` and `disabled:opacity-50 disabled:cursor-not-allowed` per docs/UI_GUIDELINES.md. The existing save path (`safeRoles = ["work"]`) is unchanged. The existing explanatory note stays.

## Testing

- `tests/forge-sandbox.test.ts`: view is checked out at the requested ref; a file written inside `fn` is returned in `strayPaths` and the view dir no longer exists afterwards; two concurrent views for the same ticket and stage get different paths; the view is removed when `fn` throws.
- Forge pipeline test (harness not yet confirmed; the plan must find or add a fake agent that reports its cwd): plan and review agents receive a cwd under `<sandboxRoot>/views/`, never the project workdir; a reviewer that writes a file settles the run `failed` with the "reviewer changed files" report.
- Sweep: a `views/` dir older than 24 hours is removed; a fresh one is kept.
- `AgentsConfigCard.test.tsx`: the sdk-lane test asserts three checkboxes, all disabled, `work` checked, `plan`/`review` unchecked.

## Out of scope

- Explain-diff and council call the CLI-only runner plus `resolveCmd`; an http lane picked for review/plan crashes them today. Unchanged here.
- Council runs in the relay.json `workdir` (the sandbox root by default).
- The legacy member relay runner (`src/relay/runner.ts`) is unchanged.
