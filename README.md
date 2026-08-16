# VibeOps

![VibeOps — your agents, supervised](docs/banner.webp)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) ![Platform: Windows | macOS | Linux](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)

**Your agents, supervised.**

VibeOps is a self-hosted agent ops console — the board is a work-order queue for supervised agents. It orchestrates a continuous loop of planning, sandboxed work, adversarial review, and human promotion, reachable over REST and MCP. A human in the desktop app and every AI coding agent you run (Claude Code, Codex, Gemini, Antigravity, Cursor) share the same queue, the same searchable memory, and the same append-only audit trail.

Vibecoding with multiple agents has a coordination problem: each agent starts cold, re-derives decisions the last one already made, and nothing records who did what. VibeOps fixes the substrate — shared state, shared memory, per-agent identity — and installs as a single file with zero configuration.

**New here?** If you are a non-developer looking to automate work, read the [End-User Guide](docs/USER_GUIDE.md). VibeOps never asks for your AI provider API keys; you bring your own CLI and keep your usage on your existing subscriptions.

## What it does

```mermaid
flowchart LR
  T["Ticket"] --> P["Plan<br/>(your chosen model)"]
  P --> W["Work<br/>isolated git worktree"]
  W --> C["Checks<br/>typecheck + tests"]
  C --> G{"Protected-path<br/>policy"}
  G -- "touched harness/config" --> B["Promote blocked<br/>until waived"]
  G -- "clean" --> R["Review<br/>(your chosen model)"]
  R -- "VERDICT: FAIL" --> P
  R -- "VERDICT: PASS" --> H["Human promote"]
  H --> M["Merged into your repo"]
```

**The forge loop.** A coordinated pipeline of plan -> sandboxed work -> adversarial review -> human promote. The expensive reasoning model touches a task only twice (writing the plan, reviewing the diff), while a cheap or local model grinds through the implementation.

Every run passes the gates below in order; a failed safety gate reverts and fails the run, and promotion is always a human step.

```mermaid
flowchart TB
  T["Ticket (open)"] --> PLAN["Plan stage<br/>composePlanPrompt + PLAN_ONLY<br/>posts plan comment, status=planned"]
  PLAN --> WORK["Work stage (status=in_progress)<br/>ensureSandbox: git worktree add<br/>agent runs in sandbox, no git commit"]
  WORK --> SENT{"Sandbox-escape sentinel<br/>detectAndRestore()"}
  SENT -- "wrote outside worktree" --> FAIL["Run failed<br/>bytes restored, bounce to planned"]
  SENT -- "clean" --> DEPS{"Deps-leak guard<br/>detectDepsLeak()"}
  DEPS -- "wrote through shared node_modules" --> FAIL
  DEPS -- "clean" --> COMMIT["forgeCommit<br/>supervisor commits to forge/&lt;id&gt;<br/>posts report, status=review"]
  COMMIT --> CHECKS["Checks<br/>runChecks in sandbox: typecheck + tests"]
  CHECKS --> POL{"Protected-path policy<br/>evaluateProtectedPaths(diff)"}
  POL -- "touched harness/config/audit<br/>no ALLOW-PROTECTED" --> VIOL["Automatic Critical<br/>promotion blocked until waived"]
  POL -- "clean" --> REV["Review stage<br/>composeReviewPrompt on git diff HEAD...forge/&lt;id&gt;"]
  VIOL --> REV
  REV -- "VERDICT: FAIL" --> PLAN
  REV -- "VERDICT: PASS" --> HUMAN["Human promote<br/>promoteSandbox: git merge --no-ff"]
  VIOL -. "blocks" .-> HUMAN
  HUMAN --> MERGED["Merged into base repo"]
```

```mermaid
pie title Ticket Status
    "Closed" : 200
    "Open" : 1
    "Review" : 1
```

```mermaid
pie title Forge Run Outcomes
    "Rejected" : 6
    "Passed" : 5
    "Stopped" : 1
```

*Data provenance: Real counts from the running API and git history of this repository, measured August 2026.*

**Cross-model economics & budget caps.** Optimize costs by combining multiple models across the forge loop. Run work against open-weights models locally while relying on frontier models for review. Apply budget caps to ensure runs never spiral out of control.

**Append-only audit trail & verification.** Every mutation is attributed to the actor that made it. The audit trail answers exactly "which agent did this," providing full visibility and doctor/verification capabilities.

**Ticketing & Knowledge (RAG).** Supporting infrastructure for your agents:
- **Work-order queue:** Real transactions, optimistic concurrency (409s instead of clobbering), tracking multi-step work as items other agents can see.
- **Knowledge that survives sessions:** A pgvector index over three layers, searchable through one `search_knowledge` tool from any connected agent:

- **Your vault** — `~/.vibeops/vault` is created on first run and indexed automatically. Drop markdown or PDF files in, or open it as an Obsidian vault (Obsidian is optional; any editor works). Point one setting at an external vault instead if you have one.
- **Notes** — a writeable document workspace (titled, versioned, audited, soft-deleted) agents use to persist decisions and gotchas.
- **Session memory** — transcripts from Claude Code, claude-mem, Codex, and Antigravity are ingested so what one agent did is retrievable by every other agent.
- **Chat memory** — every completed Operator Chat turn folds its transcript into the index under the session's project, so conversations become retrievable knowledge without anyone saving anything.

**Zero-key by default.** Embeddings run on a local ONNX model (all-MiniLM, ~23MB one-time download) — knowledge search works out of the box with no API key. Bring a Voyage key later if you want API-grade embeddings.

**One-click agent connection.** VibeOps serves MCP over streamable HTTP from the same process. The MCP settings card writes Cursor and Gemini configs for you (with a backup of anything it touches) and hands you a ready `claude mcp add` command for Claude Code.

**Per-agent identity and roles.** The bootstrap owner key is admin; mint a member key per agent from the Actors card. Members get the full collaborative work surface; only admins touch settings, provider keys, filesystem indexing, config writes, or key minting. The audit trail answers "which agent did this."

**Honest observability.** The Token Usage tab shows each coding agent's signed-in account and its real token usage read from local session logs — and explicitly tells you what VibeOps cannot see (provider-side quotas and reset limits). No fabricated dashboards.

## What it costs, measured

VibeOps is built through its own pipeline, so these are its own numbers rather than a
demo project's.

- **173 tickets** promoted through plan -> sandboxed work -> review -> human promote.
- **5 files, +217/-23 lines** changed per promoted ticket, on average.
- **125 tickets reached review; 50 of them (40%) did not pass the first one** and went
  back for rework, across 74 rework rounds total.

Read that 40% carefully, because it is the number most likely to be oversold. It is the
rate at which the review gate sent work back — not a proven defect count, and not a
controlled comparison against an unsupervised agent. A model reviewed the diff and asked
for changes; sometimes it was wrong. What it does show is that four times in ten, the
first thing the pipeline produced was not the thing that got merged.

**Token cost is deliberately absent, and that is the honest answer.** Until 2026-08-12
this project was not measuring it. Headless CLI agents report no token counts, so usage
was estimated from the length of the model's *output* alone — ignoring the prompt, which
on a plan stage carries the ticket, the retrieved knowledge and the repo context and
dominates the total. The same figure fed the per-ticket and per-day budget caps, so those
caps were enforcing against a number that did not mean anything. The estimate now counts
the prompt, and the SDK lane's token count now includes cache reads it was previously
dropping.

**If you had already set `ai.budget.perTicketTokens` or `ai.budget.perDayTokens`, raise
them.** Those caps are enforced against the number described above, which used to be far
too small — often by more than an order of magnitude. A limit that never fired before may
now stop a run part-way through a ticket, which surfaces as a 409 refusing to start the
next stage. The caps did not get stricter; they started being real. Genuine per-call token and dollar figures still exist only on the lane whose
API reports them, so a with/without comparison is not published here yet rather than
guessed at.

## What is actually guaranteed

Worth being precise about, because "supervised" can be read as a stronger promise than
the one being made.

- **The human promote step is the only hard gate.** Nothing reaches your branch without
  someone approving it. Everything below is an aid to that decision, not a substitute.
- **Checks are mechanical.** Typecheck and test commands run concurrently with the
  review, and a failing check forces `VERDICT: FAIL` no matter what the reviewer
  concluded — the reviewer cannot talk a run past a red check.
- **The reviewer is a model reading a diff.** It catches a great deal — 40% of tickets
  here went back at least once — and it is also wrong sometimes, in both directions.
- **The sandbox is a git worktree, not an OS jail.** A work agent's shell is not
  kernel-confined. Writes outside the worktree are caught by a sentinel that snapshots
  sensitive paths before the run and restores them after, which is detection and repair
  rather than prevention.
- **VibeOps never pushes code.** It commits inside sandboxes and merges into your local
  branch on promote; `git push` stays yours. The separate, opt-in issue-tracker
  connectors are the one thing that talks outward, and only if you bind a repo and supply
  a token: they mirror tickets to GitHub issues over the REST API. No code leaves.

## The desktop app, in practice

What a day in the app looks like — every feature below is shipped and test-covered:

**First run.** A setup wizard detects your installed agent CLIs (via preflight probes of each binary), writes a starter `relay.json` with only the agents that actually work, creates your first project, and walks you to your first pipeline run. Folder fields use a native folder picker everywhere — no path typing required.

**Projects as tenants.** Each project binds to its own repository; tickets, forge runs, and connections scope to the active project, with an all-projects view across them. Point "Import from folder" at a directory of repos and every git repo inside becomes a project in one click.

**The Forge screen.** Select a work order, read its full spec (editable in place, version-guarded), pick agents and exact models per role — or leave everything on Auto and let the router pick by your cost strategy. While a run is live you watch the narrated console plus a sandbox-activity panel showing files changing in real time with add/delete counts. When it settles: a side-by-side per-file diff viewer with a plain-English "Explain changes" summary generated by the cheapest capable model (cached, so it costs tokens once), the reviewer's verdict, and a model-verification badge telling you whether the CLI actually used the model you requested. Promote merges; Request changes bounces the run with your feedback injected into the next attempt. Promote is impossible mid-run or on an empty sandbox — the gates fail closed.

**Council intake.** Instead of writing tickets by hand, describe the idea and a three-persona council (believer, investor, skeptic) debates it; a chairman verdict rates it, asks clarifying questions, and only creates the ticket once it has a real spec. Failed sessions resume from the round that died instead of re-paying for the rounds that finished.

**Operator Chat.** A conversational surface for work that shouldn't be a ticket: persistent per-project sessions where an agent holds real tools — knowledge search scoped to the session's project, board reading, and live browser snapshot/read through the extension. You iterate by replying; one turn at a time per session; completed turns feed the knowledge index automatically. The agent speaks like a colleague, and when a tool refuses (say, a browser action without a grant) it relays the refusal verbatim instead of hallucinating success.

**Browser extension.** A Chrome MV3 extension (`vibeops-browser-extension.zip` on every release, or Load-unpacked from `extension/`) that registers with your local server and executes action batches: accessibility-tree snapshots and element reads work out of the box, and the mutating verbs — click, type, select, press — unlock per origin via explicit `act` grants you add in Settings. Enforcement is dual: the server refuses ungrated mutating batches (403 with the exact setting to add), and the extension independently refuses when the page origin doesn't match the granted one. Page-derived text is data, never instructions.

**Recovery without curl.** Right-click any run for a state-aware menu — Stop while it's in flight (keeps the sandbox and commits), Resume when it died recoverably, Retry from the plan. A rejection shows a one-sentence `REASON:` on the run card, and Continue launches a rework in the same sandbox with the reviewer's findings handed to the worker verbatim — no replanning, no re-paying for the work that already passed. Run History shows per-stage timings ("plan 7m / work 10m / checks 2m / review 5m") so latency arguments happen with numbers.

**Agent doctor.** Settings shows per-agent health: binary present, probe passing, authentication detected — so a renamed binary or expired login is a red dot in the UI, not a stalled run an hour later. Pipeline starts warn (or refuse, for unspawnable binaries) based on the latest probes.

**Prompt lessons.** A capped, redacted lessons document is injected into every plan stage — hard-won rules like "atomize tasks to transcription", "reuse before writing", "never provision infrastructure", "targeted tests only in the work stage". Measured effect: planners refuse contradictory tickets instead of planning them, and cheap work models clear review because the plan already did the thinking.

**Safety rails.** Untrusted text (ticket bodies, synced comments, RAG content, diffs) is fenced as data-not-instructions in every composed prompt, and an injection-corpus test proves forged verdict strings can't unlock the gates. Budget caps (per-ticket and per-day tokens) refuse pipeline starts past the limit unless explicitly forced. Exports (ticket briefs for NotebookLM and similar) pass through secret redaction.

## Install (one file)

Grab or build the installer — a single artifact per platform (NSIS `.exe` on Windows; `deb`/`AppImage` configs for Linux):

```bash
npm run build:sidecar          # bundles the server + portable Node (sha256-verified)
cd app && npm run tauri:build  # requires Rust
```

First launch self-creates everything: an embedded Postgres-compatible database (PGlite with pgvector), an owner API key at `~/.vibeops/credentials.json`, and your vault. The app spawns its own bundled server on `127.0.0.1:8787` — or attaches if one is already running. Quitting the app stops it. `~/.vibeops` is never touched by install or uninstall.

## Quick start (from source)

Node 20+ is the only prerequisite for standalone mode:

```bash
npm install
npm run dev    # REST API on :8787 — embedded DB, migrations, bootstrap, vault, all automatic
```

The desktop app auto-detects credentials. `~/.vibeops` is the single backup unit: copy the folder to back up; restore it before first run on a new machine. Treat `credentials.json` like `~/.ssh`.

**Stop the app before you copy or back up that folder.** The embedded database is
single-writer and has no inter-process locking, so a second process opening
`~/.vibeops/data` while the app is running corrupts it — not the copy, the original. This
is not theoretical: it destroyed this project's database three times in one day, every
time by running a backup or a probe script against a live server. Hard kills are fine
(the write-ahead log replays on restart); a concurrent open is not. `npm run backup` now
reads `postmaster.pid` and refuses to run while a live process holds the directory, but a
manual `cp -r` has no such guard.

Useful scripts: `npm run ingest:sessions` (index recent agent sessions), `npm run ingest:watch` (standalone vault watcher), `npm run mcp` (stdio MCP server for external-Postgres setups), `npm test`.

`npm test` picks its own lane: with the test Postgres up (`npm run db:up`) it runs the parallel suite; with it down it either falls back to a serial run against a throwaway embedded PGlite (`VIBEOPS_TEST_EMBEDDED=1`) or exits in seconds with the command to fix it — it never hangs hunting for a database. The embedded lane refuses to touch `~/.vibeops`, so a test run can never open the live app's database.

## Connect an agent

VibeOps serves MCP at `http://127.0.0.1:8787/mcp` (streamable HTTP, bearer-key auth — same key as REST). From the app: Settings → MCP Servers → the connect card writes Cursor/Gemini configs one-click and gives Claude Code users a copy-paste command. For scripting: `GET /mcp/config` returns per-client snippets; `POST /mcp/install` performs the write.

Give each agent its own key (Settings → Local Node → Actors) so the audit trail can tell them apart, then generate that agent's MCP config by calling `GET /mcp/config` with the agent's key.

Make agents actually use the shared brain: add a few lines to your agent instructions (CLAUDE.md / AGENTS.md / GEMINI.md) — search knowledge before starting, save decisions after finishing, track multi-step work as tickets. This repo's `AGENTS.md` has the canonical block.

## Agent pack

This repo doubles as a Claude Code skills marketplace: `vibeops-pack/` packages the ticket, knowledge, forge, SDD, and ponytail conventions above as installable skills. From the VibeOps app: Settings → Plugins → Add marketplace → paste this repo's URL, or a local path if you're running from source. Install any of the `vibeops-*` skills and it lands in `~/.claude/skills/<name>`, where Claude Code and Forge's `/`-autocomplete pick it up natively.

## Auto-priming

Give a fresh agent session a head start instead of starting cold: `scripts/prime.mjs` calls `GET /prime?q=<query>` and prints a compact plain-text digest of the most relevant knowledge (vault, notes, sessions) for that query. It reads `~/.vibeops/credentials.json` itself — no config needed — and defaults the query to the current directory name if you don't pass one.

Wire it into Claude Code as a `SessionStart` hook so every new session opens with relevant context already injected:

```json
{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "node D:/Github/tickets/scripts/prime.mjs" } ] } ] } }
```

Any agent with its own hook system (or a shell alias run before starting a session) can call the same script — `/prime` is member-level and read-only, so no admin key is required.

## Cross-model pipeline (relay)

Ticket work has three roles — plan, work, review — and each can run against a different agent or model, so the expensive reasoning model touches a ticket only twice (writing the plan, then reviewing the diff) while a cheap or local model grinds through the actual implementation loop in between.

- **plan**: reads the ticket and relevant knowledge, posts a `plan` comment, moves the ticket to `planned`.
- **work**: claims a `planned` ticket (optimistic-locked — two workers racing for the same ticket never both claim it), implements the plan, posts a `report` comment, moves the ticket to `review`.
- **review**: reads the plan, the report, and the real `git diff`, then closes the ticket on `VERDICT: PASS` or bounces it back to `planned` with findings on `VERDICT: FAIL`.

### Quickstart

Create `~/.vibeops/relay.json`:

```json
{
  "workdir": "D:/Github/myproject",
  "agents": {
    "fable": { "cmd": ["claude", "-p", "{promptFile}"], "roles": ["plan", "review"] },
    "codex": { "cmd": ["codex", "exec", "--oss", "--sandbox", "workspace-write", "-C", "{workdir}", "{prompt}"], "roles": ["work"] }
  }
}
```

`codex exec --oss` runs the work loop against a local open-weights model through Codex's own runtime — you don't need Ollama installed until you want `work` on a model Codex doesn't bundle.

Run one pass per role:

```bash
npm run relay -- --role plan --agent fable
npm run relay -- --role work --agent codex
npm run relay -- --role review --agent fable
```

Add `--watch` to poll continuously instead of running once, and `--ticket <id>` to target a specific ticket instead of the oldest one in that role's queue.

### Adding another AI provider

Any CLI that takes a prompt via argv or stdin and prints its answer to stdout can be a relay agent — Claude Code, Codex, and Antigravity are just the ones VibeOps ships with detection for. To add another (Kimi CLI, ollama running Llama, anything else), add an entry to `~/.vibeops/relay.json`:

```json
{
  "agents": {
    "kimi": { "cmd": ["kimi", "-p", "{promptFile}"], "roles": ["work"] },
    "llama": { "cmd": ["ollama", "run", "llama3", "{prompt}"], "roles": ["work"] }
  }
}
```

`cmd` is a placeholder — substitute the real binary and flags for whatever CLI you're wiring in. `{prompt}`, `{promptFile}`, `{workdir}`, and `{model}` are substituted per the rules in [Quickstart](#quickstart). Binaries with no built-in auth detection (i.e. not `claude`/`codex`) show "auth: unknown" in Settings > AI Models > AI Accounts — that's expected, not an error; authenticate the CLI however its provider expects, then confirm with "Run checks".

### Security note

`relay.json` — including the exact command each agent runs — lives in a local file, never the settings table. An admin API key can already read and write ticket data; if command templates lived in the DB too, that same key would amount to arbitrary command execution on whatever machine runs the relay. Keeping it filesystem-only means compromising the API can't compromise the shell.

## Architecture

```mermaid
flowchart TB
  UI["Tauri desktop shell<br/>React UI"] <--> API["Node sidecar<br/>Hono API on :8787"]
  API --> DB[("PGlite + pgvector<br/>~/.vibeops/data")]
  API --> KN["Knowledge<br/>vault - notes - sessions - repo docs"]
  API --> RELAY["Relay"]
  RELAY --> C1["claude"]
  RELAY --> C2["agy"]
  RELAY --> C3["codex / kimi"]
  KN --> DB
```

```text
Desktop app (Tauri)  ──┐
Claude Code / Cursor ──┤── REST + MCP ──► one service layer ──► Postgres (truth: tickets, notes,
Codex / Gemini ────────┘    (bearer keys,      (transactions,       events, settings, actors)
                             admin/member       audit, 409s)          │
                             roles)                                   └─► pgvector (rebuildable
                                                                           projection: vault, notes,
Vault watcher ──────────── markdown / PDF ────────────────────────────────  session transcripts)
Session ingestion ──────── Claude Code / claude-mem / Codex / Antigravity ┘
```

```mermaid
flowchart TB
  subgraph HOME["~/.vibeops (single backup unit)"]
    DATA[("data/<br/>PGlite + pgvector")]
    VAULT["vault/<br/>markdown + PDF"]
    SBX["sandbox/&lt;ticketId&gt;/<br/>git worktree on branch forge/&lt;ticketId&gt;<br/>node_modules linked from base repo"]
    CRED["credentials.json + relay.json<br/>(sentinel-protected)"]
  end
  subgraph DBGRP["PGlite embedded (or external Postgres via DATABASE_URL)"]
    TRUTH[("Truth tables<br/>tickets, notes, events,<br/>settings, actors, forge_runs")]
    VEC[("pgvector index<br/>rebuildable projection")]
  end
  DATA --- DBGRP
  VAULT --> VEC
  NOTES["Notes workspace"] --> VEC
  SESS["Session transcripts<br/>Claude Code / claude-mem / Codex / Antigravity"] --> VEC
  REPO["Repo docs"] --> VEC
  TRUTH -. "rebuild" .-> VEC
  BASE["Base repo (project workdir)"] -- "git worktree add" --> SBX
  SBX -- "promote: git merge --no-ff" --> BASE
```

- **Truth vs. retrieval:** authoritative records live in Postgres tables; pgvector holds embeddings — a projection you can always rebuild, never the sole record.
- **Database seam:** `DATABASE_URL` set → external Postgres; otherwise an embedded PGlite database in `~/.vibeops/data`. Same code, same migrations (additive-only, run at boot).
- **One code path:** REST and MCP both route through the same service layer, so every mutation lands in the same audit trail no matter who made it.

## Security model

Local-first, single trust boundary: the embedded server binds loopback only; every request needs a bearer key; keys are stored as sha256 hashes; admin/member roles gate host-touching operations (settings, provider keys, filesystem indexing, MCP config writes, key minting, session ingestion). Written client configs and `credentials.json` hold plaintext keys with owner-only file permissions — same trust level as `~/.ssh`. Portable Node downloads are verified against the published sha256 manifest; the local embedding model is pinned to a specific revision.

Session ingestion indexes conversation text from your own machine; tool output is stripped, but secrets pasted directly into chats can be indexed — treat the knowledge base accordingly.

## Advanced: external Postgres

```bash
export DATABASE_URL="postgresql://user:password@localhost:5433/vibeops"
npm run db:vector && npm run db:push && npm run db:vector:index
npm run dev
```

External mode serves all interfaces (for LAN/VPS use) and does not auto-bootstrap. The stdio MCP server (`npm run mcp`) is the right transport when agents run on a different machine than the server.

## Knowledge ingestion details

The vault watcher indexes `.md` and `.pdf` (PDF via a JVM-backed converter — needs Java 11+; without it PDFs are skipped with a warning). Files are hash-gated (unchanged files cost nothing on re-index) and deletions leave the index. Session ingestion (`npm run ingest:sessions` or the Sync button in the app) covers the last 30 days by default (`SESSIONS_SINCE_DAYS`), is hash-gated, and is safe to re-run. Run anything with `EMBED_PROVIDER=fake` for a no-network dry run.

## Native folder picker

Browse buttons next to every folder-path field use the Tauri dialog plugin, bundled by default — no setup needed. Picking a folder fills the field; typing the path directly still works.

## Platform support and release status

Tagged releases (`v*`) build and publish everything in one run: the Windows NSIS installer, the macOS `.app.tar.gz` + `.dmg`, the Linux `.deb`, the browser-extension zip, minisign signatures for every updater payload, and the `latest.json` updater manifest — with a fail-fast guard that refuses to build if the tag and the app's own version disagree (a lesson bought the hard way: one release shipped binaries that offered themselves as their own update forever).

**Windows** is the proven platform: the NSIS installer is self-contained (bundled Node runtime, embedded database, all migrations), closes running instances before upgrading, and the app kills its own sidecar on exit. **The auto-updater is live**: the app checks `latest.json` at boot and asks — a real native dialog, not a silent install — before downloading. **macOS** builds green in CI and ships signed updater artifacts; it awaits notarization and a real-hardware pass (see `docs/RELEASING.md` for the Gatekeeper workaround). **Linux** ships a working `.deb`; the AppImage (the Linux auto-update path) was blocked by onnxruntime's GPU provider libraries demanding CUDA on the build runner — those are stripped now, pending the next tag to confirm.

Remaining caveat: the Windows executable is not Authenticode-signed, so SmartScreen warns on first run.

Connectors: GitLab, Jira, and Asana sync issues/epics into the board (credential-less until you add tokens in Settings); GitHub uses an account-level personal access token with per-project repository binding. NotebookLM is export-only by design (it has no public ingestion API) — one click downloads a redacted markdown brief of any ticket or council spec.

## License

[MIT](LICENSE)
