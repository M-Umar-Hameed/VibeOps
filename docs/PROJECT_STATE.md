# VibeOps — what it is, what we set out to build, where it stands

Last updated 2026-08-22 at commit `4b042b3` (938 commits since 2026-07-07). This is the one document to read first. It says what the app is for, what the intended scope was, what has actually shipped, and what is still open. Detailed architecture lives in `VibeOps.md`; per-feature designs live in `docs/superpowers/specs/`; the end-user walkthrough is `docs/USER_GUIDE.md`.

## What the app is

VibeOps is a self-hosted agent ops console. The board is a work-order queue for supervised AI coding agents. A human in the desktop app and every agent the owner runs (Claude Code, Codex, Gemini/Antigravity, Kimi, Cursor, anything with a CLI) share one ticket queue, one searchable memory, and one append-only audit trail, reachable over REST and MCP.

The problem it exists to solve: vibecoding with several agents has a coordination problem. Each agent starts cold, re-derives decisions the previous one made, and nothing records who did what. VibeOps fixes the substrate (shared state, shared memory, per-agent identity) and installs as one file with no configuration. It never holds the user's AI provider keys for the agents; each agent runs on the user's own CLI subscription. The one exception, added by choice, is OpenRouter for chat, where the user supplies their own key.

## What we wanted

The owner's standing goals, in the order they were set:

1. **A supervised forge loop.** Plan with the best model, implement with the cheapest model that can do the job, review adversarially, and never merge without a human promote. The expensive model touches a task twice (plan, review); a cheap model grinds the implementation in an isolated git worktree.
2. **One memory for every agent.** Tickets, notes, vault documents, session transcripts, repo content and chat all indexed into one searchable knowledge base, and handed back to agents without them having to ask.
3. **Agents as first-class actors.** Per-agent API keys, roles, audit events for every mutation, and a relay so any CLI can take any pipeline role.
4. **A real product, not a dev tool.** A Tauri desktop app with an embedded database, a one-file installer, auto-update, and a non-developer guide. No Docker, no Postgres, no config for the end user.
5. **Dogfooding.** VibeOps builds VibeOps: the pipeline is the way work gets done in this repo, and its own failures are tickets on its own board.
6. **Chat that can act.** A chat surface in the app that uses any model, knows the board and the knowledge base, and can drive the user's browser through an extension.
7. **Memory that speaks first.** Decisions, rules and handoffs that are injected into chat, pipeline stages and the user's own Claude Code sessions before anyone searches for them (the basemode idea, adopted on 2026-08-22).

## Scope, as built

Phases 1 to 4 were the original plan (ticket engine, knowledge/RAG, desktop app, inbound sync). Everything after that came from dogfooding: each gap the owner hit became a spec, a ticket and a shipped slice. The spec directory is the real changelog; the list below is what each area does today.

**Ticket engine and audit.** Tickets, comments, actors with hashed API keys and roles, optimistic concurrency (`version`, 409 on stale writes), append-only `events` for every mutation from REST, MCP, ingest or sync. Project tenants and workspaces. GitHub Issues inbound sync.

**Knowledge and memory.** pgvector index over vault markdown and PDFs, notes, session transcripts from Claude Code / Codex / Antigravity / claude-mem, repo content and chat. Local zero-key embedder by default, Voyage optional. Scoped global / project / ticket. `search_knowledge` on MCP and chat. As of 2026-08-22: typed memory (decisions with rationale, domain-scoped rules, handoffs) on the notes table, a `recall` service that fires rules by exact domain and decisions by similarity, injection into every chat lane and into forge plan/work prompts, `/recall` and `/prime` routes for Claude Code hooks with an installer, `save_decision`/`save_rule` tools, background auto-capture after chat turns and work stages, and `*handoff`.

**Forge pipeline.** Plan -> sandboxed work in a git worktree -> checks (typecheck, tests) -> protected-path policy -> adversarial review -> human promote. Sandbox-escape sentinel restores any bytes written outside the worktree; deps-leak guard; mutation gate; file-set gate (files outside the plan's declared set block automatically); budget caps; run survival across sidecar restarts (pid plus process start time identity; reattach on boot); stall sweep; review chunking for oversized diffs; lessons clause on plan prompts (A/B-tested, deliberately absent on work prompts).

**Agent relay.** `~/.vibeops/relay.json` declares lanes: `cli` (any command with `{prompt}`/`{model}` placeholders), `sdk` (Claude Agent SDK, tool-capable), and since 2026-08-22 `http` (OpenAI-compatible endpoints, chat-only). Live lanes today: claude, claude-sdk, agy (Gemini), kimi, openrouter; codex declared but not installed. Model router with verification levels (parsed model banners where the CLI prints one, best-effort otherwise). Agent doctor checks binaries and sign-in state.

**Council.** Multi-persona intake that interrogates an idea before it becomes a ticket, with awaiting-answers rounds and a chairman spec.

**Desktop app.** Tauri 2 + React 19 over the REST API: board, ticket detail, forge run view with live output and stage timing, chat, knowledge browser, usage, settings (AI models and keys, agents config, browser grants, integrations, MCP one-click install, plugins, workspaces). Embedded PGlite database at `~/.vibeops/data` with snapshots and restore; no Docker for users. Single-file installers for Windows, macOS and Linux with a signed updater manifest, built and published by a tag-triggered workflow with size budgets and a manifest-completeness guard.

**Chat.** Sessions per project, rename and delete, processing state derived from the server (survives app restarts), failures persisted into the transcript. Lanes: SDK (tools: knowledge, board, browser), CLI lanes (tools via the lane's own MCP client when wired), OpenRouter (any catalog model, user key, chat-only). Memory block injected on every lane.

**Browser extension.** MV3 Chrome extension linked to the sidecar with an origin-scoped grant model (read free; act requires a per-origin grant the agent cannot self-issue; refusals name the exact setting). Verbs: snapshot (accessibility tree with refs and geometry), read, click, type, select, press, navigate, clickAt, screenshot, set-of-marks (numbered boxes on a screenshot so any model, vision or not, can pick a target), tabs, newTab, switchTab. Heartbeat via a 30 s alarm so the worker survives Chrome's idle kill; the options page only claims LINKED when the server confirms the session. Playwright e2e runs it in real Chrome against the live sidecar.

**Operations.** Pipeline overhead measured (work stage dominates because agents run full suites; review is 0 to 1 min); the optimization plan (quick wins and structural tiers) is complete, including the 500 MB sidecar payload cut and the run-survival chain. Test lanes: parallel Postgres slices when Docker is up, serial embedded PGlite otherwise; a shared-stack safety fix so a sandbox can no longer destroy the test database.

## What we have achieved, by the numbers

- 938 commits over 47 days; published releases v0.1.2 through v0.1.6 (v0.1.6 tag predates the latest chat, tab and memory work; next release is 0.1.7).
- Server suite: 996 tests, 973 passing on the embedded lane; the 8 failures are the fixed set that needs a real Postgres (global-setup, relay-pipeline, sidecar-payload, forge-resume, one vector-dim test) and pass when Docker is up. App suite: 223 passing. Extension e2e: 5 checks in real Chrome.
- 31 design specs under `docs/superpowers/specs/`, each implemented through the forge or, where the pipeline was too slow for the slice, directly with the same review discipline.
- The board is the record: every incident this project hit (stalled runs, orphaned agents, corrupted embedded DB, release mismatches, extension disconnects, silent chat failures) exists as a ticket with its diagnosis and fix.

## What is open

Tracked on the board, all under the VibeOps project:

- `712b13d8` (high) — `/prime` still returns knowledge-hit lines unfenced and only appends the untrusted-data clause when a handoff exists; `fenceUntrusted` does not escape a closing tag inside a payload. Do this before leaving memory auto-capture on by default.
- `36f00249` — hook scripts block on an idle TTY stdin; no test for `prime.mjs`; cwd project matching should reuse the project path normaliser.
- `81c1cd2a` — memory polish: move `noteIndexText` out of the import cycle, slug multi-word project names into domains, let `updateNote` patch kind/domain/rationale, a review surface for auto-captured notes.
- `1421c63f` — owner's future plan: customer notification automation.

Known limits worth stating plainly:

- Auto-captured rules are written by a model and read by shell-capable agents with no review surface yet. The extractor input is fenced and bounded, but the trust model is "member-level can write memory".
- The code-graph half of basemode (tree-sitter map injected before a file is touched) was deferred on purpose; only the memory half is built.
- OpenRouter is chat-only: no tools, no pipeline roles. Pipeline roles need an agent harness that can edit files, which a chat-completions endpoint cannot.
- Full desktop control (S2-B style) was rejected by the owner; the browser extension is the automation surface.
- Docker-only tests cannot run in a Docker-less session; a green embedded lane plus the fixed failure set is the accepted signal.

## How work gets done here

`CLAUDE.md` at the repo root is binding: plan and review on the best model, implement with the cheapest capable model as a subagent, break work into tasks small enough to transcribe, gate every task with a reviewer, mutation-test before promote, and write the least code that works. The forge pipeline is the default vehicle; direct implementation with the same review loop is the fallback when a slice is fully specified and the pipeline's overhead would exceed the work. Nothing is pushed by an agent; the owner pushes and tags.
