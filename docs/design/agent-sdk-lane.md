# Design doc: Agent SDK in-loop lane alongside the relay

## 1. Positioning

The current relay lane relies on a BYO-CLI approach, using a `cmd` arg-vector spawn (`src/relay/invoke.ts:28-90`). In this model, subscription auth lives inside each CLI, maintaining a zero keys stance in VibeOps.
The proposed SDK lane is a first-party in-loop integration using `@anthropic-ai/claude-agent-sdk`. It leverages the `CLAUDE_CODE_OAUTH_TOKEN` generated from `claude setup-token`. The token lives in Claude Code's credential store (`~/.claude/.credentials.json` on Windows/Linux; macOS Keychain), and VibeOps only reads the environment variable at spawn. This perfectly matches the existing relay zero-keys stance documented in the `src/relay/config.ts:22-23` comment.
**Council verdict:** The relay stays default. The SDK lane is additive.

## 2. Architecture

The SDK lane will be a second implementation behind the existing `runAgent` contract:
`(agent, prompt, workdir, onData?, onSpawn?) => Promise<{ok, output}>` (`src/relay/invoke.ts:28-90`).
We propose a new `src/relay/invoke-sdk.ts` to implement this. Selection will happen per-agent via a new proposed optional field `RelayAgent.type?: "cli" | "sdk"` in `relay.json` (`src/relay/config.ts:8`), defaulting to `"cli"`. The `loadRelayConfig` validation (`src/relay/config.ts:22-85`) will be extended to support this.
The dispatch point at the `runAgent` call sites in `pipeline()` (`src/forge/runs.ts:268-367`, specifically `291,321,350`) stays unchanged; selection happens in one wrapper.
Message-stream handling: SDK assistant/user messages are rendered to text and appended via existing `onData` → `append` (`src/forge/runs.ts:86-88`), preserving redaction.
Sandbox identically: The SDK lane receives the exact same `ensureSandbox` worktree path as `workdir`/`options.cwd` (`src/forge/sandbox.ts:88-97`), and `forgeCommit` (`src/forge/sandbox.ts:99-107`) / `sandboxDiff` (`src/forge/sandbox.ts:109-117`) remain unchanged.
To address process management where `Run.child` is currently `ChildProcess` (`src/forge/runs.ts:71`) and `stopRun` calls `killTree` (`src/forge/runs.ts:557-563`): the SDK lane substitutes an `AbortController`. We propose extending the run shape minimally (e.g. adding `Run.abort?: () => void`) to accommodate both without implementing full child processes for SDK runs.

## 3. In-loop supervision

Permissions use the SDK's `canUseTool` callback. The policy will:
- Allow Read/Grep/Glob always.
- Allow Edit/Write only for paths resolving inside the sandbox worktree.
- Allow Bash for test/check commands.
- Deny writes resolving outside the sandbox, citing the live-incident comment (`src/forge/runs.ts:46-51`).
- Unknown tools: log allow-or-deny decisions as `[forge: permission-warning ...]` markers into the run output, mirroring the `applyVerification` markers (`src/forge/runs.ts:124-144`).
T19 checks in-loop: For SDK runs, we run `resolveChecks`/`runChecks` (`src/forge/checks.ts:16-30,64-75`) triggered from the loop (e.g. after the SDK's final edit turn or on a Stop-style hook) instead of the between-stage call at `src/forge/runs.ts:337-346`. Failing check text is fed back into the loop as a user turn so the agent can fix it before the stage ends. Relay runs will keep the between-stage placement.

## 4. Telemetry

The SDK `result` message carries real `usage` data (`input_tokens`, `output_tokens`) and `total_cost_usd`. This replaces the `outputChars/4` estimate (`src/services/usage.ts:17-30`).
This real telemetry feeds `logAgentUse` (`src/services/usage.ts:17-30`) to populate `ai_usage_logs` (`src/db/schema.ts:142-152`, including the `cost` column ×1e6 fractional cents, today always 0) and `agent_sessions` (`src/db/schema.ts:154-160`) via the existing `track()` wrapper (`src/forge/runs.ts:96-109`). It also makes the `checkBudget` caps (`src/forge/runs.ts:467-496`) accurate for SDK runs.
We propose extending `UsageEntry` with optional real `tokens`/`cost` fields to support this design.

## 5. Native tools

We will provide SDK custom tools wrapping `searchKnowledge(q, {limit})` (`src/services/knowledge.ts`) and `addComment`/`updateTicket` (`src/services/comments.ts`, `src/services/tickets.ts`) using in-process calls with no HTTP hop.
For prompt injection, tool results will be wrapped with `fenceUntrusted` + `UNTRUSTED_CLAUSE` (`src/relay/prompts.ts:11-17`), reusing the same knowledge/comments fencing logic we use today.

## 6. Failure modes

- **Token expiry:** SDK auth errors will cause the run to fail. This should be surfaced like the doctor soft-failures in `pipelineStartWarnings` (`src/relay/doctor.ts`). The remedy is to re-run `claude setup-token`.
- **SDK↔CLI version drift:** Because the SDK spawns the CLI subprocess under the hood, this is a real risk. We need a pin strategy and doctor-style preflight.
- **Windows process handling:** SDK abort behavior versus our `killTree` taskkill tree-kill (`src/relay/invoke.ts:19-26`) poses an orphaned subprocess risk.
- **Fallback:** To revert, simply flip the agent `type` back to `"cli"` (or omit it) in `relay.json`. The relay lane is untouched by construction.

## 7. Phased plan

- **Phase 1 MVP:** SDK lane for `work` stage only, implementing the sandbox-write-guard `canUseTool` policy and real-token telemetry.
  - AC: One ticket runs the work stage via the SDK agent end-to-end in the sandbox; the `ai_usage_logs` row has a real token count; outside-sandbox writes are denied in a test.
- **Phase 2:** Support `plan`/`review` stages. These run in the REAL workdir, so the `PLAN_ONLY` guard (`src/forge/runs.ts:42-58`) becomes an enforced deny-all-writes `canUseTool` policy, which is strictly stronger than today's prompt-level guard.
  - AC: Full pipeline runs SDK-only on a throwaway ticket; `parseVerdict` (`src/relay/prompts.ts:81-85`) still gates properly.
- **Phase 3:** Native knowledge/ticket tools and in-loop T19.
  - AC: A knowledge tool call is visible in the run output with fenced results; a failing typecheck is fixed in-loop without a second pipeline pass.
Each phase will be scoped as one forge ticket.

## 8. Open questions

- Stop semantics: `stopRun` / `Run.child` shape vs AbortController.
- Timeout: Whether the SDK lane respects `RelayAgent.timeoutMs` (`src/relay/config.ts:8`).
- Model verification: `applyVerification` / `verifyModel` (`src/forge/verify.ts`) parses CLI stdout today, but the SDK `system` init message carries the model. This requires a different mechanism.
- Concurrency: Interaction with concurrent-sandbox limit of `MAX_ACTIVE=3` (`src/forge/runs.ts:29`).
- Feedback loops: Whether the `analyzeRun` prompt-lessons loop (`src/forge/runs.ts:402-444`) applies to SDK message streams.
- Sourcing: The source of truth for the token-cost `cost` column population.
