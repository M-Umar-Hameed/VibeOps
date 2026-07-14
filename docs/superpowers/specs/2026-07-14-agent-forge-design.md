# Agent Forge (Phase 17) — Design

Date: 2026-07-14. Approved by owner.

## Purpose

UI-driven multi-model orchestration: from the VibeOps app, pick a plan model, a
work model, and a review model, run a ticket through the full pipeline, and watch
the agents think out loud — with all work confined to a sandbox until a passing
review AND a human Promote action. Modeled on AutoForge's orchestrator/process-
manager/live-feed architecture, adapted to VibeOps' existing ticket + relay
primitives.

Constraints carried in from the relay spec (still binding):

- Agent command templates live ONLY in `~/.vibeops/relay.json`. They are never
  stored in the settings DB and never returned by any API. `/forge/agents`
  exposes agent NAMES and ROLES only.
- No model API keys are stored or proxied for agents. Forge spawns locally
  CLI-authed tools (`claude -p`, `codex exec`, `gemini -p`) — subscription-ToS
  clean.
- All spawns are arg-vector (`spawn(cmd0, rest)`), never shell. stdin ignored.
- The user pushes to remotes manually. Forge never pushes.

## What AutoForge taught us (and what we deliberately do differently)

- Process manager in the API layer owning long-running agent subprocesses, with
  a status enum, output capture, and crash cleanup that un-claims orphaned work
  — adopted.
- Chain-of-thought = no hidden thinking: agents narrate steps to stdout because
  the prompt demands it, and the UI mines that stream — adopted (simpler: raw
  console, no regex state trackers in v1).
- Atomic work claims via guarded UPDATE — VibeOps already has this (ticket
  optimistic version locks).
- AutoForge runs agents in the REAL workdir on the REAL branch, guarded by a
  bash allowlist. We instead give each ticket a git worktree on its own branch:
  stronger isolation, and promotion is a normal merge.
- AutoForge has no per-role model routing. VibeOps does (relay roles) — the
  forge UI surfaces it as three dropdowns.

## Architecture

New backend module `src/forge/` in the sidecar; reuses `src/relay/prompts.ts`
(compose*/parseVerdict), `src/relay/invoke.ts` (runAgent, extended with an
onData callback), and `src/relay/config.ts` (loadRelayConfig — `workdir` is the
base repo forge operates on). Unlike the relay CLI (separate process, REST),
forge runs inside the sidecar and calls service functions directly.

### sandbox.ts — worktree lifecycle

- `sandboxPath(ticketId)` = `~/.vibeops/sandbox/<ticketId>`; branch
  `forge/<ticketId>`. Base repo = relay config `workdir` (must be a git repo).
- `ensureSandbox(ticketId)`: if the worktree exists, reuse it (rework after a
  FAIL continues in the same tree). Else `git worktree add <path> -b <branch>`
  from the workdir's current HEAD.
- Workers are prompted NOT to commit. After a successful work stage, forge
  itself commits everything in the sandbox: `git add -A` +
  `git commit -m "forge: <ticket title>"` on the forge branch. The branch is
  the durable artifact; the diff endpoint serves
  `git diff <merge-base(workdir HEAD, branch)>..<branch>` (capped 150k like
  relay).
- `promote(ticketId)`: refuse if the workdir has uncommitted changes (dirty
  check via `git status --porcelain`); else `git merge --no-ff forge/<id>` in
  the workdir, then remove worktree + delete branch, close the ticket with an
  audit comment. Merge conflict → abort the merge, surface the error, sandbox
  kept.
- `discard(ticketId)`: `git worktree remove --force` + `git branch -D`, ticket
  back to `planned` with an audit comment.

### runs.ts — run manager

- In-memory `Map<runId, Run>`; `Run = { id, ticketId, stage: plan|work|review,
  agents: {plan, work, review}, status: running|passed|failed|stopped, output
  (append-only string, 400k cap), child, startedAt, finishedAt }`. Not
  persisted: the durable record is ticket comments (plan/report/review), same
  as relay. Server restart loses only the live console.
- One active run per ticket; global cap 3 concurrent runs; exceeding either →
  409.
- Pipeline execution (single run, stages sequential):
  1. plan: skipped if ticket already has a plan comment and status ≥ planned;
     else compose plan prompt (+ knowledge), run plan agent in workdir
     (read-only role), post `plan` comment, status → planned.
  2. work: claim via optimistic version update to `in_progress`;
     ensureSandbox; compose work prompt with `workdir = sandboxPath` and the
     narration clause; run work agent IN THE SANDBOX; on success forge-commit
     the sandbox, post `report` comment, status → review. On failure/exit≠0:
     post failure report, status → planned (never stuck in_progress — same
     invariant as relay).
  3. review: compose review prompt with the SANDBOX BRANCH diff; run review
     agent in workdir; post `review` comment. PASS → ticket STAYS `review`
     (differs from relay CLI, which closes): sandbox + passing verdict =
     "awaiting promote". FAIL → status `planned`, sandbox kept for rework.
- Output: every stdout/stderr chunk appends to `run.output` with stage marker
  lines (`=== FORGE plan (codex) ===`) injected between stages. A light
  redaction pass runs on each chunk before buffering (common key shapes:
  `sk-[A-Za-z0-9]{16,}`, `pa-[A-Za-z0-9_-]{16,}`, `Bearer <token>`, and
  `"apiKey":"..."` values → `[redacted]`).
- Stop: kill the child's process tree (reuse invoke's killTree); run status →
  stopped; ticket bounced to `planned` if it was claimed by this run.
- Chain-of-thought clause appended to the forge work prompt (relay CLI prompt
  unchanged): "Narrate your reasoning out loud as you work: before each step,
  print what you are about to do and why. Your narration is read live by the
  supervisor and by the reviewing model."

### Routes (all admin-gated; mounted in app.ts)

- `GET  /forge/agents` → `[{ name, roles }]` from relay.json (no cmd).
- `POST /forge/pipeline` `{ ticketId, planAgent, workAgent, reviewAgent }` →
  `{ runId }` (agents validated against config roles).
- `GET  /forge/runs` → active + recent runs (id, ticketId, stage, status,
  agents, timestamps — no output).
- `GET  /forge/runs/:id/output?after=N` → `{ chunk, next, stage, status }`;
  UI polls ~1s. Offset-based, idempotent, no streaming transport needed
  (Tauri's http plugin cannot consume SSE bodies).
- `POST /forge/runs/:id/stop`.
- `GET  /forge/tickets/:id/diff` → sandbox branch diff (404 if no sandbox).
- `GET  /forge/tickets/:id/sandbox` → `{ exists, branch, lastVerdict }`
  (lastVerdict parsed from the newest review comment).
- `POST /forge/tickets/:id/promote` / `POST /forge/tickets/:id/discard`.
  Promote additionally requires the newest review comment to parse as PASS.

### Frontend — `/forge` route (built by gemini via the relay, supervised)

Single screen: left column = tickets grouped by status (open/planned/
in_progress/review, review split visually into "in review" vs "PASS — awaiting
promote"); right panel for the selected ticket = three agent dropdowns
(plan/work/review, from `/forge/agents`), Run pipeline button, live console
(1s output polling, autoscroll, stage markers styled), diff viewer (mono,
scrollable), and Stop / Promote / Discard buttons gated by sandbox state +
verdict. Uses the existing `app/src/lib/api.ts` verb facade (returns body
directly — NOT `res.data`).

## Security model

- Every `/forge/*` route behind `auth` + `requireAdmin` (spawning CLIs and
  merging code = admin power).
- Command templates: read from relay.json at pipeline start, never persisted,
  never echoed. Errors mention agent NAME only.
- Sandboxes only ever under `~/.vibeops/sandbox/`; ticketId path-sanitized
  (UUIDs only — reject anything not matching the id shape).
- Promote refuses a dirty workdir; merge failures abort cleanly.
- Output redaction before buffer/persist (best-effort, defense in depth — the
  real guarantee is that forge never injects secrets into prompts).
- Isolation honesty: a worktree confines the DIFF, not the process. A
  malicious/prompt-injected agent could still write outside the sandbox;
  mitigations are the CLIs' own sandboxes (`codex --sandbox workspace-write`
  etc.) and single-user local trust — same trust level as running these CLIs
  by hand. Documented, not solved, in v1.

## Testing

- sandbox.ts against a temp git repo fixture: create → edit → forge-commit →
  diff → promote merges into base and cleans up; dirty-workdir refusal;
  discard removes branch; rework reuses the tree.
- runs.ts with `tests/fixtures/fake-agent.mjs`: full pipeline happy path
  (comments posted, statuses walked, PASS leaves ticket in review); work
  failure bounces to planned; verdict FAIL keeps sandbox; concurrency caps
  (second run on same ticket → 409); stop kills and bounces.
- Route authz: member key → 403 on every /forge route (extends authz suite).
- Redaction unit tests.
- Promote gate: promote without PASS verdict → 409.

## Out of scope (later pickup)

- Multi-agent parallel batching / dependency-aware scheduling (AutoForge's
  scheduler) — one ticket at a time per run is enough now.
- Structured agent-state tracking (thinking/working/struggling mascots) —
  raw console first.
- Run history persistence table; WS/SSE transport; auto-pipeline watch mode
  (relay --watch already covers headless).
