# Supervised forge vs bare agent CLIs: audit, measured numbers, guard blueprint

Date: 2026-11-09. Repo state: `9136048` (master). Data window: 2026-10-14 to 2026-11-06.

This evaluates whether running coding agents through the VibeOps forge buys anything over running the same CLIs bare. It has four parts: the lifecycle as actually built (with what is missing), a comparison with raw Claude Code, the numbers this install has really recorded, and a tested guard blueprint for the three gaps the audit found.

## Verdict

- **The forge's value is its gates, not context engineering.** On 1,139 real runs across a 450k-LOC monorepo and VibeOps itself, 46.5% of tickets failed their first review (131 of 282). Of 293 failed reviews, 120 failed on a red typecheck/test run and 100 on a mechanical scope or secret block. Without the gate, that work would have landed as it was.
- **The supervision itself is cheap. Rework is not.** The median review takes 0.7 minutes. Planning plus review is about 43k estimated tokens per promoted ticket. Tickets that passed first time cost a median $0.51 of work-stage spend. Tickets that needed at least one rework round cost $2.71, which is 5.3 times as much.
- **Command safety is the weakest layer.** The SDK-lane deny list (`src/relay/risk.ts`) blocked 110 of 257 destructive commands in a red-team corpus (42.8%) and blocked none of the 83 benign ones. Its own comment names the reason: it uses regex segments, not a shell parser. Two lanes (kimi, codex) get no deny list at all. The agy lane runs with `--dangerously-skip-permissions` behind a deny list that has never been verified against a live run.
- **Several idealized capabilities do not exist:** AST/repo-map context pruning, mid-run context injection, structured failure causes, per-call token splits, tool-call telemetry, and an N-strikes loop breaker. Nothing in the code or docs claims the first two. The schema does imply the middle ones: `forge_runs.cause`, `stage_times` and `ai_usage_logs.exact` exist but are mostly unwritten.
- **There is no measured bare-agent baseline, and this report does not invent one.** The "bare" column in Part 3 is unmeasured. A paired replay harness that would fill it is specified there.

## Data and method

| source | what it gave | limits |
|---|---|---|
| `GET /forge/runs?ticketId=` for all 304 tickets (live API, read-only) | 1,139 runs with status, agents, stage durations | durations are reconstructed from usage rows after the run settles (see 1.5) |
| `~/.vibeops/backups/export-2026-11-06T23-47-36-882Z.json` | tickets, 2,199 comments (plans, reports, reviews with `VERDICT:` lines, `forge: promoted` markers), 7,403 events | events cover tickets and notes only |
| read-only copy of the PGlite snapshot `data.good-2026-11-06T15-10-33-505Z` | 1,128 `forge_runs` rows, 2,397 `ai_usage_logs` rows | the copy was deleted after export; the live `~/.vibeops/data` was never opened |
| `~/.vibeops/runs/*.log` (5,882 files) | denial and guard markers | CLI lanes log only the agent's final text |
| git history of both repos | promote and revert commits | |
| `src/relay/risk.ts` driven by a 340-command corpus | deny-list recall and false positives | evaluation policy is broader than VibeOps's own (see 1.3) |
| Claude Code docs (code.claude.com/docs), fetched 2026-11-07 | raw-CLI capabilities for Part 2 | docs state behavior, not measured behavior |

Codebases in the data: `monorepo` (450,181 lines of code files; 904 runs, 247 tickets) and VibeOps (69,240 lines; 235 runs, 48 tickets). Code areas were audited by reading the source; every claim below cites `path:line`. Eight load-bearing claims were re-checked by hand against the code before publishing (stage_times unwritten, single `cause` writer, single `tokens` column, agy bootstrap flags, per-lane deny wiring, reattach settle, declared-path regex, usage summing).

---

## Part 1: The lifecycle as built

```mermaid
flowchart TB
  T["Ticket (free text, admin-gated directives)"] --> R["Routing: local model picks cheapest-first or quality-first"]
  R --> K["Retrieval: 5 knowledge hits (markdown only) + memory block <= 2400 chars"]
  K --> P["Plan stage: best model, read-only HEAD view, free-form plan"]
  P --> W["Work stage: cheap model in git worktree, lane-specific guards"]
  W --> S{"Sentinel + deps-leak (after work only)"}
  S -- "escape" --> F["Run failed, bytes restored"]
  S -- "clean" --> C["forge commit on forge/<id>"]
  C --> CH["Checks: typecheck/tests, 5 min timeout, tail 100 lines"]
  C --> G["Gate: file-set, secrets, mutation, citations (block) / AC-map (warn)"]
  CH --> RV["Review: cold session on diff (40k cap, chunked), fail-closed VERDICT parse"]
  G --> RV
  RV -- "FAIL (or red check, or gate block)" --> PL["Ticket back to planned; sandbox kept; next run is an explicit start"]
  RV -- "PASS" --> H["Human promote: git merge --no-ff"]
  X1["AST / repo-map pruning"]:::absent -.-> K
  X2["Mid-run context injection / compaction"]:::absent -.-> W
  X3["N-strikes breaker + auto rollback"]:::absent -.-> PL
  classDef absent stroke-dasharray: 5 5,color:#888
```

Dashed nodes are capabilities from the idealized spec that do not exist.

### 1.1 Task ingestion and context assembly

| step | what it does | why | success criterion |
|---|---|---|---|
| Intake | Title and body stored verbatim. New directive lines (`GATE-OVERRIDE`, `ALLOW-PROTECTED`, `ALLOW-FILES`, `ALLOW-COMMAND`, `EXPORT-TO`, `EVIDENCE`) require an admin actor (`src/services/tickets.ts:15-22`). | Untrusted authors cannot switch gates off through ticket text. | Non-admin directive write throws `ForbiddenError`. |
| Routing | For strategy `balanced`, a local model answers a yes/no question about the ticket and picks cheapest-first or quality-first. It fails open to balanced (`src/forge/runs.ts:470`). | Match model tier to task. | `run.agents` resolved for plan, work and review. |
| Retrieval | The query is the title plus the first 500 body chars. HNSW cosine search, re-ranked by a 90-day recency decay, keeps the top 5 (`src/forge/runs.ts:1233-1236`, `src/services/knowledge.ts:445`). A separate recall block holds rules, decisions and knowledge, capped at 2,400 chars. | Hand agents prior decisions without them asking. | `knowledge[] <= 5`, memory block <= 2,400 chars. |
| Prompt composition | Ticket body, comments (12,000-char budget, newest first), memory and knowledge are fenced as `UNTRUSTED` with a data-not-instructions clause (`src/relay/prompts.ts:12-15`). Skills: up to 3, 16,000 chars each (`src/forge/skills.ts:8`). | Bound injected context and contain prompt injection. | Prompt built once per stage. |

Claims vs the idealized spec:

| claim | verdict | detail |
|---|---|---|
| Ticket normalized into a structured directive | **absent** | No schema or field extraction. The LLM-written plan becomes the de facto directive. |
| AST-driven context pruning (dependency graph, repo map) | **absent** | No tree-sitter, import graph or repo map anywhere in `src/`. Retrieval indexes markdown only (`src/services/knowledge.ts:331`). The tree-sitter map was deferred on purpose (`docs/PROJECT_STATE.md:68`). Agents explore the repo with their own tools. |
| Injected context is budgeted | **partial** | Caps exist per section, but there is no global prompt budget. The plan text goes into the work and review prompts whole. Retrieval has no relevance floor, so it always returns `limit` rows (`src/services/knowledge.ts:445-456`). |
| Retrieved memory carries provenance and is treated as untrusted | **partial** | Fencing is real and tested. Provenance is uneven: recall lines drop `sourceRef`, and auto-captured decisions look the same as owner-written ones (`src/services/recall.ts:113-115`). |

### 1.2 Supervisor planning and scope verification

| step | what it does | why | success criterion |
|---|---|---|---|
| Plan | The best model runs in a read-only HEAD view. It must name every file it will touch and mark unmeasured numbers (`src/relay/prompts.ts:42-62`). | The expensive model thinks once; the cheap model transcribes. | Non-empty plan comment; status `planned` (`src/forge/runs.ts:766`). |
| Model pairing | Plan and review: quality-first. Work: cheapest-first. After 2 or more failed reviews, work escalates one quality step (`src/forge/router.ts:38,53-56`). | Cost per role. | Agents chosen per role. |
| Scope check | After work, the diff file list is compared with the plan-declared token set plus `ALLOW-FILES` globs. Unexpected files are an automatic block that forces FAIL (`src/forge/gate.ts:35-75`). | Workers cannot widen scope silently. | No unexpected files, or review forced to FAIL. |

| claim | verdict | detail |
|---|---|---|
| Supervisor produces a strict, phased plan before tools run | **partial** | A plan precedes work, but it is free text with no schema and no validation beyond "non-empty". |
| Scope verified before tool invocation | **different** | Scope is checked after the work stage, on the diff. Before tools run, the worker is only asked to "change only the files the plan names". |
| Scope enforced mechanically after execution | **exists** | File-set gate. It is deliberately loose: any `word.ext` token counts, and basenames match anywhere. So a plan that names `index.ts` authorizes every `index.ts` in the repo (`src/forge/gate.ts:30-34,69-73`). |
| Directives cannot be injected | **partial** | Strong at the service layer. Directives are stripped from sync imports and planner output. An admin-keyed agent can still add `GATE-OVERRIDE`. |
| Model matched to task difficulty | **exists** | Role-based pairing plus escalation. Escalation counts every historical FAIL and never resets on a re-plan (`src/forge/runs.ts:333`). |

### 1.3 Sandboxed execution and command guardrails

| lane | filesystem confinement | command deny list | notes |
|---|---|---|---|
| claude CLI | `--restricted` plus allow-list wall (app-level) | `--settings` deny globs, wall on or off | Claude Code's own docs: Bash rules "aren't a security boundary" |
| claude-sdk | `canUseTool` realpath write gate | `PreToolUse` hook running `commandRisk()` | the only lane with exact, path-aware matching |
| agy | none | per-run `command(...)` deny rules | bootstrap uses `--dangerously-skip-permissions` (`src/relay/bootstrap-config.ts:48`); deny rules not verified live |
| codex | codex OS sandbox (`workspace-write`) | none | |
| kimi | cwd only | none | (`src/relay/invoke.ts:115-116` applies deny lists to claude and agy only) |

Detection and repair: the sentinel snapshots enumerated sensitive paths (default: `relay.json`, `credentials.json`, the Windows server payload) and restores them after the **work** stage only. The deps-leak guard reverts additions made through the shared `node_modules` junction. Plan and review stages are not re-checked.

| claim | verdict | detail |
|---|---|---|
| Execution is sandboxed | **partial** | A git worktree is directory isolation, not an OS boundary. The README says so (README "What is actually guaranteed"). |
| Destructive commands blocked (rm -rf, git resets, DB drops, egress) | **partial** | 11 rule ids (`src/relay/risk.ts:44-92`). No rules for database operations or generic egress. `git reset --hard` is blocked only when the target contains `origin`. |
| Blocked operations recorded as telemetry | **partial** | A free-text marker in run output, on the SDK lane only (`src/relay/invoke-sdk.ts:48,58,61,103`). No counter, column or event. |
| Writes outside the sandbox prevented or repaired | **partial** | Prevented by lane-level tools where present. Repaired by the sentinel for the enumerated paths only. |
| Mid-run prompt injection and compaction | **absent** | Prompts are written once, then stdin is closed (`src/relay/invoke.ts:228-232`). The only mid-run controls are abort, timeout and stall-kill. |

**Red team of `commandRisk()` (SDK lane), 340 commands.** Workdir was a temp dir. The commands were passed to the classifier only, never executed.

| category | total | caught | evaded (rule exists) | no rule | false positive |
|---|---|---|---|---|---|
| recursive delete | 36 | 26 | 10 | 0 | - |
| git destructive | 30 | 12 | 2 | 16 | - |
| database | 12 | 0 | 0 | 12 | - |
| egress / exfiltration | 17 | 5 | 0 | 12 | - |
| publish / deploy | 15 | 10 | 2 | 3 | - |
| disk / system | 18 | 3 | 2 | 13 | - |
| obfuscated forms | 79 | 30 | 44 | 5 | - |
| PowerShell / cmd | 50 | 24 | 15 | 11 | - |
| benign dev loop | 83 | - | - | - | **0** |
| **total** | 340 | **110 / 257 (42.8%)** | 75 | 72 | **0 / 83** |

Within the classes `risk.ts` targets, it caught 110 of 185 (59.5%). Evasion classes, one example each: wrapper prefixes (`command rm -rf /`, `nohup`, `time`, `timeout 5 git push`); absolute or escaped binaries (`/bin/rm -rf /`, `\git push`); shell re-entry (`sh -c 'rm -rf /'`, `eval "git push"`); `find / -exec rm -rf {} +`; `xargs rm -rf`; `${HOME}` (split on the brace); git global options before the subcommand (`git --no-pager push`); line continuations; dynamic command names (`$(echo rm) -rf /`). Part of this policy is broader than VibeOps's own: it adds DB, egress and system classes, and treats any `reset --hard` as destructive. Those rows are counted under "no rule", not "evaded". Claude Code's own matcher splits compound commands and checks subcommands inside `$(...)` and control-flow bodies. So the claude CLI lane catches some of the compound-form evasions that `commandRisk()` misses, but by its own docs it does not catch `/usr/bin/curl`, `sh -c '...'` or `git -C . push`.

### 1.4 Automated gatekeeping, verification and loop-breaking

| step | what it does | success criterion |
|---|---|---|
| Checks | Operator-configured commands (default `npm run typecheck` if the script exists), sequential, 5-minute timeout, output capped at 200,000 chars, last 100 lines kept (`src/forge/checks.ts:8-11,34`). A failing check forces `VERDICT: FAIL` whatever the reviewer says (`src/forge/runs.ts:1160`). | All check commands exit 0. |
| Mechanical gate | Blocks: secret in branch history, file outside declared set, mutation probe ("dead test passes with guard reverted"), dangling citations. Warns: AC-map. A gate error degrades to a warning (fail open) (`src/forge/gate.ts:225-345`). | No block findings. |
| Review | Cold session on `git diff HEAD...forge/<id>`, chunked past 40,000 chars (`src/forge/runs.ts:61,1062`). Last-match, line-anchored `VERDICT` parse, fail closed. | `VERDICT: PASS` and no forced FAIL. |
| Promote | PASS leaves the ticket in `review`. A human calls promote, which runs `git merge --no-ff` and refuses a dirty workdir (`src/forge/sandbox.ts:491-497`). | Merged; sandbox discarded. |

| claim | verdict | detail |
|---|---|---|
| Post-execution checks (tests, lint, diff analysis) | **exists** | Checks plus the mechanical gate. The tests run are whatever the operator configured, not targeted to the diff. |
| Completion validated by evidence, not self-report | **exists** | A red check or a gate block forces FAIL. A model PASS never merges on its own. |
| Failed verification triggers rollback | **different** | Nothing is rolled back because nothing has landed: work lives on `forge/<id>` until promote. On FAIL the sandbox is kept for rework. Discard is a manual route. |
| Loop-breaking (halt after N failures) | **absent, by design differently** | There is no automatic rework loop at all. After FAIL the ticket returns to `planned`, and the next run needs an explicit start. Bounds: escalation after 2 failed reviews, per-ticket and per-day token caps (`src/forge/runs.ts:440,1270`), stall kill after 30 minutes without output, check timeout. `forge_queue` and `promoteOnPass` exist in the schema but nothing writes or reads them. |
| Budget caps stop runaway spend | **partial** | Enforced, but against estimated tokens for every CLI lane (README "What it costs, measured"). |

### 1.5 Session auditing, telemetry and persistence

| claim | verdict | detail |
|---|---|---|
| Per-stage latency logged in real time | **partial** | `forge_runs.stage_times` is declared and persisted, but nothing ever assigns it. Durations are reconstructed after the run settles from `ai_usage_logs` rows, with a +/-5 s window join (`src/db/schema.ts:224`). |
| Token split (input/output/cached), exact vs estimated | **partial** | One `tokens` integer per row (`src/db/schema.ts:159`). The parsers sum input, output, cache-creation and cache-read tokens into it (`src/relay/usage-json.ts:18`). `exact` exists, but 3 of 2,397 rows in this window have `exact = true`. |
| Tool-call distribution per run | **absent** | No tool columns. Session ingest drops `tool_use` blocks. |
| Structured failure classification | **partial (schema only)** | The single writer of `cause` is the base-conflict path (`src/forge/runs.ts:999`). `causeDetail` is never set. In this window, 371 of 412 failed runs carry only "worker failed" plus the agent's trailing narration. |
| Runs survive restarts; append-only audit | **partial** | Pid plus start-time reattach works, but a reattached run always settles `interrupted`, even if the stage succeeded (`src/forge/runs.ts:1631`); 110 runs ended `interrupted`. `events` covers tickets and notes only, with no DB-level append-only enforcement. |
| Concurrent runs with visibility and conflict detection | **partial** | `forge.maxActiveRuns` (default 3), run list plus SSE `/events`. Overlap detection is an advisory, plan-text-only warning. |

---

## Part 2: Raw Claude Code vs VibeOps supervision

Raw Claude Code facts come from its docs (code.claude.com/docs, fetched 2026-11-07). "Raw" here means one Claude Code session on the repo, interactive or `-p`, with no external supervisor.

| dimension | raw Claude Code | VibeOps forge |
|---|---|---|
| **Context degradation and compaction** | Auto-compacts near the window limit (about 967K tokens on 1M-context models). The threshold is configurable (`/autocompact`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`), and `PreCompact` hooks can steer or block it. Bash output beyond about 30,000 chars is not inlined; the full output is saved to a file and the agent gets the path. One long session accumulates plan, edits, test output and retries in a single context. | Each stage is a fresh, cold session: plan, work and review never share a context. Injected context is capped per section (5 hits, 2,400-char memory, 16k per skill, 40k diff with chunking). There is no repo map, no global budget and no mid-run compaction, so a long work stage still relies on the CLI's own compaction. Isolation bounds review context; it does not shrink work context. |
| **Error loops and runaway spend** | `--max-turns` and `--max-budget-usd` (print mode, client-side estimate). There is no built-in "N red test runs then stop"; an interactive loop runs until a human intervenes. | No automatic loop exists. Every rework is an explicit run start. Model escalation after 2 failed reviews; token caps per ticket and per day (enforced on estimates); 30-minute stall kill. Measured: median 0 and p90 3 failed reviews before promote, max 13. Rework multiplies median work cost by 5.3. |
| **Destructive commands and sandbox** | Deny/ask rules: the docs say they are not a security boundary. `PreToolUse` hooks can be exact (exit 2 blocks before rules are evaluated). The OS sandbox (filesystem plus network) runs on macOS, Linux and WSL2, **not native Windows**. Checkpoints do not cover Bash side effects ("use version control"). | The agent works in a git worktree. Nothing reaches the base branch without a human promote: that is the hard guarantee. The deny list varies by lane (above): 42.8% recall on the red-team corpus, none for kimi and codex. The sentinel repairs enumerated paths after the work stage. Neither layer is an OS jail. |
| **Verification and "done"** | "Done" is the agent's own claim, unless the user wires hooks or CI. | Checks force FAIL, the mechanical gate forces FAIL, a cold adversarial reviewer parses fail-closed, and a human promote is required. Measured: 46.5% first-review rejection; 120 check-forced and 100 gate-forced FAILs out of 293. |
| **Multi-tasking and visibility** | Agent view for background sessions (research preview), subagents, `/tasks`. Usage per session from `--output-format json` (`total_cost_usd`). | One board and run list across projects, `maxActiveRuns` cap, SSE events, multi-account failover on usage limits. Gaps: failure cause unstructured, no tool-call telemetry, usage mostly estimated, overlap warning advisory. |

Where raw Claude Code is ahead: real OS sandboxing (outside native Windows), a documented and exact hook interception point, and exact cost reporting in `-p` mode. VibeOps uses only part of that: hooks on the SDK lane only, cost only from the SDK lane.

---

## Part 3: Quantitative results

### 3.1 Measured on this install (supervised arm only)

Window: 2026-10-14 to 2026-11-06. 1,139 runs on 295 tickets: passed 275, rejected 295, failed 412, interrupted 110, stopped 47.

| metric | value | n | how it was computed |
|---|---|---|---|
| First-review pass rate | **53.5%** (151) | 282 tickets that reached review | first `VERDICT:` line per ticket; matched exactly by the first passed/rejected run per ticket |
| Tickets promoted | **268** | 295 | `forge: promoted` comments; git shows 254 `forge: promote` merges in the window (228 monorepo, 26 VibeOps) |
| Promoted with zero failed reviews | 147 (54.9%) | 268 | |
| Failed reviews before promote | median 0, p90 3, p95 4, max 13 | 268 | |
| Runs per promoted ticket | median 2, p90 6, p95 10 | 268 | includes failed and interrupted runs |
| Failed reviews forced by red checks | 120 | 293 FAILs | `[forge: check(s) failed` marker |
| Failed reviews forced by mechanical gate | 100 (file-set 94, secret 5, mutation 2) | 293 FAILs | `AUTOMATIC BLOCK` findings |
| Promoted with no extra human action | 243 (90.7%) | 268 | excludes run starts and the promote itself; the other 25 had a human comment (7), policy waiver (7), gate override (3) or merge failure (9) |
| Sentinel restores (write outside worktree) | 4 | 1,139 runs | `forge: sandbox escape` reports |
| Deps-leak failures | 4 | 1,139 runs | |
| Recorded command denials | 8 mentions in 7 logs, **all benign commands** blocked by the allow-list wall (shell loops, grep pipelines, jest/tsc) | 5,882 logs | no destructive command block is recorded; CLI lanes log only final text, so denials there are invisible |
| Failed runs by cause | worker failed 371, planner failed 14, reviewer failed 9, stalled 6, sandbox escape 4, deps leak 4, git/pipeline error 4 | 412 | first line of the `forge:` report; "worker failed" carries no structured cause |
| Stage duration p50 / p90 / p95 (min) | plan 2.0 / 5.4 / 6.8; work 2.6 / 18.3 / 30.0; checks 2.5 / 4.5 / 5.2; review 0.7 / 2.4 / 3.2 | 304 / 969 / 577 / 594 stages | `stageDurationsMs` from the API |
| Passed run wall time p50 / p90 / p95 (min) | 6.9 / 18.4 / 26.9 | 275 | |
| Ticket created to promoted | p50 0.4 h, p90 5.2 h | 268 | |
| Review PASS to promote (wall clock) | p50 0.6 min, p90 1.3 min, p95 5.9 min | 268 | latency, not effort; it shows promote is usually a quick confirmation |
| Work-stage cost per promoted ticket (SDK lane, reported) | **median $1.19**, p90 $5.68, p95 $9.66, mean $2.27 | 220 | `ai_usage_logs.cost` (micro-dollars, SDK `total_cost_usd`); API-equivalent, not the subscription bill |
| ...same, zero failed reviews | median $0.51, p90 $1.77 | 114 | |
| ...same, at least one failed review | median $2.71, p90 $10.08 | 106 | |
| Work-stage tokens per promoted ticket (SDK, reported) | median 1.72M, p90 12.8M | 220 | input + output + cache creation + cache read summed in one column, so dominated by cache reads |
| Plan + review tokens per promoted ticket | median 42.7k, p90 206k | 262 | **estimates** (chars/4 on CLI lanes) |
| Total SDK work-lane spend in window | $507.48 | 477 rows | |
| Reverts of promoted work | 0 | both repos | weak proxy for regressions; fix-forward is not counted |

### 3.2 What the requested benchmark needs and why it is not here

| requested metric | status |
|---|---|
| First-pass completion, bare vs supervised | **unmeasured (bare).** The closest internal evidence: the work stage is a bare CLI run under a plan, and 46.5% of first outputs did not survive review. That counts what the gate stopped, not what a bare agent would have shipped, because a bare session may iterate further on its own. |
| Token/API cost per completed ticket, bare vs supervised | **unmeasured (bare).** Supervised work-stage cost is measured above. Plan and review run on subscription CLIs that report no cost, so the cost of supervision itself is known only as an estimate (about 43k tokens per ticket median). |
| Hallucination, unintended deletion, regression rates | **unmeasured.** No labeled data exists. Proxies: 4 sentinel restores, 94 file-set blocks (scope creep), 0 reverts. |
| Human review time per changeset | **unmeasured.** PASS-to-promote latency (0.6 min median) is wall clock, and the review comment is written by a model. |

**Harness to fill the bare column (paired replay, not yet run).** Replay at least 30 closed tickets from this board at their base commits. For each ticket:
- Arm A: bare `claude -p` with the ticket text, the same work model, `--max-turns 60 --output-format json`, in a fresh worktree.
- Arm B: the forge pipeline on the same base.

Score both arms the same way:
1. Hidden acceptance: the tests from the promoted diff, applied after the run.
2. The full suite, for regressions.
3. A blinded human review (accept / reject plus minutes spent).
4. Cost: `total_cost_usd` from the JSON for arm A; usage rows for arm B.
5. Destructive events: a filesystem snapshot outside the worktree, diffed after each run.

Report the paired difference with a McNemar test on acceptance and a Wilcoxon test on cost. At this install's measured rates, 30 pairs cost on the order of $60-150 of API-equivalent spend. Running it creates tickets and runs on the board, so it needs the owner's go-ahead.

### 3.3 Published evidence (context, not VibeOps numbers)

| finding | number | source (checked against the primary page 2026-11-09) | transfer caveat |
|---|---|---|---|
| Harness choice moves benchmark scores more than model choice at the top | within-model scaffold range up to 29.8 points vs an 8.8-point spread across the top 30 SWE-bench entries | [arXiv:2609.17394](https://arxiv.org/abs/2609.17394) | observational; the authors say it does not identify causal scaffold effects |
| Experienced developers were slower with early-2025 AI tools | 19% longer (CI +2% to +39%); developers believed they were 20% faster | [METR, 2025-07-10](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/) | METR's [2026-02-24 update](https://metr.org/blog/2026-02-24-uplift-update/) says the follow-up data are unreliable (selection effects) and that speedups are likely larger now |
| Long inputs degrade reliability even on trivial tasks | 18 models, performance non-uniform as input grows | [Chroma, "Context Rot"](https://research.trychroma.com/context-rot) | supports cold per-stage sessions; not measured on coding agents |
| An unsupervised agent deleted a production database during a code freeze | 2025-07-18 incident, CEO: "unacceptable and should never be possible" | [Fortune, 2025-07-23](https://fortune.com/2025/07/23/ai-coding-tool-replit-wiped-database-called-it-a-catastrophic-failure) | different product; illustrates the DB-destructive class `risk.ts` has no rule for |
| Average Claude Code spend | about $13 per developer per active day; under $30 for 90% of users | [Claude Code docs, costs](https://code.claude.com/docs/en/costs.md) | enterprise averages, not per ticket |

---

## Part 4: Guard blueprint

Folder: `blueprint/`. It is standalone TypeScript run directly by Node 24 (type stripping), with zero dependencies, and it is not wired into the server. It covers the three gaps the audit measured: command interception that parses instead of pattern-matching, bounded tool output, and a loop that stops itself. Usage is in `blueprint/README.md`.

| file | lines | role |
|---|---|---|
| `firewall.ts` | ~1,120 | `checkCommand(cmd, { workspace, dialect })` returns allow, or deny with a rule id, reason and offending segment |
| `claude-hook.ts` | 32 | Claude Code `PreToolUse` adapter for Bash and PowerShell; exit 2 on any internal error (fail closed) |
| `output-budget.ts` | 151 | streaming clip: head 2,000 chars + tail 6,000 + up to 30 error-like lines from the middle with line numbers |
| `run.ts` | 89 | `runCommand` / `runGuarded`: firewall, then spawn, clip and timeout with a process-tree kill (`taskkill /T` or a process group) |
| `verify-loop.ts` | 127 | agent step, then tests; 3 consecutive failures -> stash (incl. untracked), reset to the starting commit, alert |

### 4.1 Command firewall

How it works. A small shell lexer handles quotes, ANSI-C strings, line continuations, heredocs, `$(...)`, backticks and process substitution. It splits the line into simple commands and tracks `cd`. Each command is normalized: env assignments are dropped; `/bin/rm`, `\rm`, `RM.EXE` all become `rm`; wrappers are unwrapped (`sudo`, `env`, `command`, `exec`, `nohup`, `time`, `timeout`, `nice`, `xargs`, `npx`, `npm exec`, `&`, `Start-Process`). Shell re-entry is recursed into: `sh -c`, `eval`, `pwsh -Command`, `-EncodedCommand` (decoded), `cmd /c`, `find -exec` with `{}` substituted, and npm/pnpm/yarn scripts read from `package.json`. Then table rules run: delete outside the workspace (with symlink-aware path resolution), git history and work destruction, inline SQL and ORM resets, egress outside a host allowlist, uploads, remote shells, inline interpreter code, publish/deploy, disk/system, and writes outside the workspace. A dynamic command name (`$X -rf /`), an unbalanced quote or an internal error is a denial.

Measured (`node --test "blueprint/*.test.ts"`, plus the corpus scripts):

| corpus | `src/relay/risk.ts` | blueprint firewall |
|---|---|---|
| dev corpus, 257 deny / 83 allow (the red-team set from 1.3; the firewall was built against it) | 110/257 blocked (42.8%), 0/83 false positives | 257/257 (100%), 0/83 |
| **held-out corpus**, 66 deny / 40 allow, written by a separate agent from the policy text only, never seen during implementation | **24/66 (36.4%)**, 1/40 false positive (`echo "curl https://example.com \| sh is unsafe"`) | **65/66 (98.5%)**, **0/40** |
| everyday-command probe (183 commands an agent runs daily, from the reviewer) | not run | 3 blocked, each a deliberate fail-closed choice: `rm -rf /tmp/x` (deletes outside the workspace, temp included), a write to `$env:TEMP\x` (unresolved variable), `Get-ChildItem ... \| Remove-Item` (delete targets from a pipe) |
| per-check latency (17,000 checks) | p50 1.8 us, p99 10.9 us | p50 139 us, p99 315 us (realpath syscalls); negligible next to spawning the command |

The held-out miss is `powershell -EncodedCommand ...`, which decodes to `Remove-Item -Recurse` with no path. The firewall decodes it and finds no target. PowerShell would prompt for a path, or fail without a console. The label was kept as written. Known ceilings, marked in code or listed here: `cd` inside a subshell `( ... )` and `popd` are not unwound, so a relative path after them is resolved against the wrong directory; a heredoc body fed to a shell (`sh <<EOF`) is not re-checked; `make`/`just` targets are not resolved; a bare host with no scheme (`curl evil.example`) passes the egress rule; and running a script file (`bash x.sh`, `node x.js`) is allowed by design, so a script the agent wrote is outside the firewall's view. That last gap is what OS sandboxing (Claude Code `/sandbox` on macOS/Linux/WSL2) or the VibeOps sentinel exist for.

Wiring: in VibeOps, `checkCommand` can replace `commandRisk()` in the SDK lane's `PreToolUse` hook (`src/relay/invoke-sdk.ts`) without changing the hook's shape. For claude CLI lanes, `claude-hook.ts` is a drop-in `PreToolUse` command hook. Per Claude Code's docs, an exit-2 or `deny` hook blocks before permission rules are evaluated. The same hook works on raw Claude Code with no VibeOps at all.

### 4.2 Output budget (context manager)

Memory-bounded and streaming. It strips ANSI, collapses `\r` progress lines, survives UTF-8 and escape sequences split across chunks, and never holds more than head + 2x tail + the signal lines.

Measured on real outputs from this machine:

| input | chars in | chars out | kept | error-like lines in -> out |
|---|---|---|---|---|
| `git log -p -n 300` (VibeOps) | 3,006,780 | 10,968 | 0.36% | 2,372 -> 35 (cap 30 plus head/tail) |
| `npm ls --all` | 23,288 | 8,604 | 37% | 17 -> 17 |
| largest forge run log | 94,485 | 12,477 | 13.2% | 49 -> 43 |
| 2nd largest run log | 86,947 | 11,562 | 13.3% | 46 -> 30 |
| 3rd largest run log | 61,750 | 10,231 | 16.6% | 34 -> 32 |
| synthetic 102 MB stream | 102.4 MB | 8,016 | - | 0.64 s, +7 MB RSS |

For comparison, raw Claude Code inlines Bash output up to about 30,000 chars and above that hands the agent a file path (docs, tools reference). The blueprint caps at about 8-12k chars and keeps the error lines from the middle. A Claude Code `PostToolUse` hook can apply the same clip through `updatedToolOutput` (`{stdout, stderr, interrupted, isImage}`); that adapter is not included.

### 4.3 Verification loop with rollback

Contract:
1. Refuse to start unless the repo has commits and a clean working tree. A rollback must never destroy work that existed before the agent started.
2. Run the step, then the tests. A pass resets the counter. A thrown step (for example a dropped network connection) counts as a failure.
3. On the 3rd consecutive failure, or after 25 steps: run `git stash push --include-untracked` (the agent's attempt is kept as a stash, not deleted), then `git reset --hard <baseline>` if the agent committed. Check the tree is clean, then call the alert. An alert failure never breaks the rollback.

Scenarios run in temp git repos (`blueprint/verify-loop.test.ts`, `run.test.ts`, all passing):

| scenario | result |
|---|---|
| pass on attempt 1; fail, fail, pass | `passed` (attempts 1 and 3), no alert |
| 3 failing steps that modify a tracked file and add an untracked one | `halted`, alert with `consecutiveFailures: 3`, `rollbackOk: true`; file restored, untracked file gone, one stash entry holding the attempt |
| fail, pass (not done), fail, fail, pass | `passed`: the counter resets on a pass |
| agent commits a bad change, then 3 failures | HEAD reset to baseline; `alert.headBefore` = the bad commit (recoverable) |
| dirty tree at start; not a git repo | `refused`, step never called |
| step throws 3 times (network drop) | `halted` with rollback |
| alert callback throws; webhook unreachable (`http://127.0.0.1:9/`) | loop still returns `halted`, rollback done |
| test command hangs (`setInterval`) with a 1.5 s timeout | counted as failure; the hanging process is verified dead (`taskkill /T`) |

Also covered: a step that switches to another branch and fails 3 times leaves that branch untouched and returns to the starting branch; a test runner that cannot spawn still ends in `halted` with rollback; a background child holding the output pipes no longer keeps the run open.

Not exercised here: a POSIX host (process-group kill), the 5-second hard deadline after a failed kill, a repo with submodules, and a git lock left by a crashed git (that would surface as `rollbackOk: false` with the git error in the alert).

### 4.4 How the blueprint was built, and what the review gate caught

It went through this repo's own loop. The spec was written by the best model. Two cheaper implementer agents built it test-first. An independent reviewer gated it, a fix agent cleared the findings, and every claim was re-run by the controller. That reviewer found 8 Important defects that all 43 original tests had missed:
1. The rollback rewound whatever branch the agent had switched to.
2. A background grandchild held the pipes and leaked the process.
3. A test runner that could not spawn rejected without rolling back.
4. The `cmd.exe` fallback mangled quotes and could pass a test falsely.
5. PowerShell `$var` statements were wrongly blocked.
6. PowerShell here-string commit messages were wrongly blocked.
7. The Claude Code hook failed open on a module-load error.
8. A `time -p` wrapper slipped past.

All 8 are fixed with regression tests, and the suite is now 51/51 with tsc clean. A first review that also hunted for new evasions was stopped by Anthropic's model safety filter. So the independent evidence for the firewall's coverage is the held-out corpus above, not an adversarial review.

---

## Recommendations, ranked by risk removed per line of code

1. **Put a real shell parser in front of every lane.** Replace `commandRisk()`'s regex segmentation with the blueprint firewall (or its tokenizer) on the SDK hook, and give kimi and codex a deny path: wrap their spawn with the same check, or drop those lanes from `work`. This closes the 75 evasions and the 72 uncovered commands measured in 1.3.
2. **Stop shipping agy with `--dangerously-skip-permissions` until its deny rules are verified live.** It is the default work and plan lane in the bootstrap config.
3. **Write the failure cause.** Set `run.cause` / `causeDetail` in `bounce()` for the 9 known classes (stall, timeout, usage limit, spawn, checks, sentinel, deps leak, planner, reviewer). 371 of 412 failures are unclassifiable today.
4. **Store the token split.** Add `input`, `output`, `cache_read`, `cache_creation` columns. The parsers already have the numbers (`src/relay/usage-json.ts:18`); they sum them away.
5. **Assign `stage_times`,** or drop the column. Durations reconstructed from usage rows misattribute when runs on one ticket are close together.
6. **Tighten the declared-path match.** Require full repo-relative paths for files that exist in more than one directory. The basename rule currently authorizes every `index.ts` once one is named.
7. **Run the paired replay in 3.2** before quoting any bare-vs-supervised number externally.
