# Optimization Structural Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. In this repo each task below is filed as one forge ticket (opus plan, Flash work, opus review); checkboxes track promotion.

**Goal:** Land the structural tier of docs/optimization-plan.md — the architecture-level changes that quick wins could not reach.

**Architecture:** Seven subsystems, each phased so that phase A is independently valuable and independently reviewable. Phases marked **[now]** are executable in a single session; **[next]** needs a working session of its own; **[later]** depends on an earlier phase landing first.

**Tech Stack:** Node/Hono sidecar, PGlite+pgvector, Tauri v2 + Rust, React 19 + TanStack Query, esbuild payload, vitest.

**Spec:** docs/optimization-plan.md sections S1-S7. Quick-wins tier shipped separately (docs/superpowers/plans/2026-08-16-optimization-quick-wins.md).

## Global Constraints

- No new npm dependencies without an explicit budget line in the task.
- Tickets touching `package.json`, `package-lock.json`, `tsconfig.json`, `tests/global-setup.ts` or `.github/**` carry `ALLOW-PROTECTED:` in the body.
- Every behavioural change ships the test that fails without it, plus a named mutation the reviewer runs.
- Never edit `~/.vibeops/credentials.json` or `relay.json` while a run is live — the sandbox-escape sentinel restores them and fails the run.
- Run the dev server as `npm run serve`, never `npm run dev`, while pipelines are active (until S2-A lands).

---

## S2 — Run-supervisor process isolation (largest item; highest daily pain)

Today every run's state lives in an in-memory Map (`src/forge/runs.ts:108`), so any restart kills every in-flight run. Promote already orders DB writes before the merge to dodge this.

### Task S2-A1: Persist run process identity **[now]**

**Files:** Modify `src/db/schema.ts` (forge_runs: `pid integer`, `logPath text`, `runToken text`), new drizzle migration; `src/forge/runs.ts` (write them at spawn). Test: `tests/forge-run-identity.test.ts`.

**Interfaces:** Produces `forgeRuns.pid | logPath | runToken` columns; `runToken` is a random uuid also injected into the child env as `VIBEOPS_RUN_TOKEN`.

- [ ] Failing test: starting a run persists a non-null pid, logPath and runToken; the spawned child's env carries the same token.
- [ ] Migration + column writes.
- [ ] Green in both lanes; mutation: dropping the token from the child env fails the test.

### Task S2-A2: Agent stdio to log files, detached spawn **[now]**

**Files:** Modify `src/relay/invoke.ts` (spawn `detached: true`, stdio to the run's logPath instead of pipes, `unref()`), `src/forge/runs.ts` (tail the log for live output instead of reading pipes). Test: extend `tests/relay-unit.test.ts`, `tests/forge-runs.test.ts`.

- [ ] Failing test: a spawned agent writes to its logPath and the run output still streams (tail), with the parent not holding the pipe.
- [ ] Implement; keep `killTree` working against a detached child (it takes the pid, so it does).
- [ ] Mutation: reverting to piped stdio fails the log-file assertion.

### Task S2-A3: Boot reattach instead of blanket-interrupt **[next]**

**Files:** Modify `src/forge/runs.ts` `markInterruptedRuns` → `reattachOrInterrupt`: for each running row, `process.kill(pid, 0)`; alive AND its `/proc`-equivalent env token matches → re-attach (resume log tail, leave status running); dead → mark interrupted as today. Test: `tests/forge-reattach.test.ts`.

- [ ] Failing test: a row whose pid is a live process with a matching token stays `running` across a simulated boot; a dead pid becomes `interrupted`.
- [ ] Guard PID reuse via the token; never reattach on token mismatch.
- [ ] Mutation: dropping the token check makes a reused-pid test fail.

### Task S2-B: Supervisor process **[later]**
Depends on A1-A3. Move spawning into an unwatched supervisor sharing state through the DB. Only worth doing if restarts still bite after A.

---

## S3 — Push, not poll

Forge active state is ~3 HTTP req/s across five polling sites.

### Task S3-A: Server event stream **[now]**

**Files:** Create `src/api/events.ts` (an EventEmitter singleton + `GET /events` via Hono `streamSSE`), modify `src/api/app.ts` (register), `src/forge/runs.ts` (emit `run.stage`, `run.settled`), `src/services/tickets.ts` (emit `ticket.changed`). Test: `tests/events-sse.test.ts`.

**Interfaces:** Produces `emitEvent(type: string, payload: unknown): void`; SSE frames `{ type, payload }`; heartbeat comment every 25s.

- [ ] Failing test: a client consuming `/events` receives a `run.stage` frame after a stage transition; `/events` 401s without a key.
- [ ] Implement with `streamSSE`; no new dependency.
- [ ] Mutation: removing the emit from the stage transition fails the test.

### Task S3-B: Client subscribes, pollers retire **[next]**

**Files:** Create `app/src/lib/events.ts` (one EventSource, maps event type → `invalidateQueries` key), modify `app/src/routes/forge.tsx`, `list.tsx`, `create.tsx` (drop `refetchInterval`, keep them as reconnect fallback only). Test: app tests asserting no interval polling while the stream is connected.

---

## S4 — Single-writer database hardening

Four corruptions, all concurrent-open.

### Task S4-A: Exclusive lock with heartbeat **[now]**

**Files:** Modify `src/db/lifecycle.ts` (acquire an OS-level exclusive lock on the data dir at open; refuse to start with an actionable message if held; release on clean shutdown), `src/api/server.ts` (surface the refusal). Test: `tests/db-lock.test.ts`.

- [ ] Failing test: a second opener refuses with a message naming the holding pid; a stale lock whose pid is dead is reclaimed (never a time-based steal).
- [ ] Implement with `fs` primitives — no new dependency unless the task budgets one explicitly.
- [ ] Mutation: allowing a time-based stale steal fails the dead-pid-only test.

### Task S4-B: Rust-owned sidecar lifetime + single instance **[next]**
`tauri-plugin-single-instance`; spawn the sidecar from Rust setup with lifetime tied to app exit.

---

## S5 — Knowledge scope column **[now]**

**Files:** Modify `src/db/schema.ts` (embeddings gains `projectId uuid` + index), migration + backfill from the current `source_ref` prefix convention, `src/services/knowledge.ts` (replace the unindexable regex scope filter with the column). Test: `tests/knowledge-scope-column.test.ts`.

- [ ] Failing test: project-scoped search uses the column and returns the same rows the regex returned (parity fixture covering repo/vault/chat/note/session refs).
- [ ] Backfill migration; verify counts before/after.
- [ ] Mutation: dropping the scope predicate leaks another project's rows into results.

---

## S1 — Per-platform payloads, remainder **[next]**
QW2/QW3 already strip dead weight and prune foreign binaries per leg. Remaining: per-platform `tauri.<os>.conf.json` so the resources entry itself differs, and a single-target npm install per leg instead of the win+linux merge.

## S6 — Chunked review context **[next]**
Past `DIFF_PROMPT_CAP`, chunk the review per-directory instead of stat+truncate; keep the whole-diff stat in every chunk preamble. Structured outputs for verdict/findings on the SDK lane.

## S7 — ForgeScreen decomposition **[later]**
Split the 1300-line component into subscription-scoped children with Query `select`; enable React Compiler after its lint passes. Best done after S3-B removes the polling that drives most re-renders.

---

## Execution order

1. **[now] tranche:** S2-A1, S2-A2, S3-A, S4-A, S5 — five independent tickets, no ordering constraints between them.
2. **[next] tranche:** S2-A3, S3-B, S4-B, S1-remainder, S6.
3. **[later]:** S2-B, S7 — only after measuring whether the earlier phases already fixed the pain.
