# Optimization Quick Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. In this repo the concrete execution vehicle is the forge pipeline: each task below is filed as one forge ticket (opus plan, Flash work, opus review) and the checkboxes track ticket promotion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the quick-wins tier of the architecture optimization plan: ~330MB off every artifact, O(new) chat embedding, per-request DB work eliminated, O(1) output rendering, seconds off boot and review.

**Architecture:** Eight independent, low-risk changes, none crossing subsystem boundaries. Measurement lands first so every other task has a before/after. Tasks are grouped into three waves of three so the max-active-runs cap holds and promote restarts never kill a sibling's work stage.

**Tech Stack:** Node/Hono sidecar, PGlite+pgvector, esbuild payload, Tauri v2, React 19 + TanStack Query, vitest (test-lane).

**Spec:** docs/optimization-plan.md (the 13-agent review). QW1 shipped as 1962c45; QW5 (frontendDeps junction overlay) deferred to its own plan — deps-leak blast radius deserves isolation.

## Global Constraints

- No new npm dependencies except react-virtuoso in Task 7 (explicitly budgeted by the spec).
- Tickets touching protected paths carry the allowance line in their body: Task 2 `ALLOW-PROTECTED: .github/workflows/release-build.yml`; Task 7 `ALLOW-PROTECTED: app/package.json, app/package-lock.json`.
- Every behavioural change ships with the test that fails without it; review runs the named mutation.
- Wave N+1 starts only after wave N's promotes land (promote restarts interrupt in-flight runs).

---

## Wave 1 — measurement + self-contained wins

### Task 1: Request and boot metrics (M1-M4 from the spec)

**Files:**
- Create: `src/services/metrics.ts` (~40 lines)
- Modify: `src/api/app.ts` (one `app.use` + one GET route), `src/api/server.ts` (boot-phase timing wraps), `src/forge/runs.ts` (`markInterruptedRuns` counter), `src/services/knowledge.ts` (`upsertSourceDoc` embed counter)
- Test: `tests/metrics.test.ts`

**Interfaces:**
- Produces: `bump(name: string, n = 1): void`, `timing(name: string, ms: number): void`, `snapshot(): { counters: Record<string, number>; timings: Record<string, { count: number; totalMs: number }> }` — in-memory, process-lifetime, no DB.
- Route: `GET /system/metrics-lite` (admin) returns `snapshot()`.

**Steps:**
- [ ] Failing test: `bump("x")` twice → `snapshot().counters.x === 2`; `timing("boot.snapshot", 120)` → totalMs 120, count 1; GET route returns them and 401s without a key.
- [ ] Implement the module (plain object maps; no classes, no persistence — the spec's M-instruments want deltas across a session, not history).
- [ ] Wire call sites: `bump("req." + c.req.method)` in one middleware; `bump("runs.interrupted", n)` where `markInterruptedRuns` marks; `bump("embed.chunks", embedded)` in `upsertSourceDoc`; `timing("boot.snapshot"| "boot.walreplay" | "boot.ensureIndex", ms)` around the existing server.ts boot phases.
- [ ] Tests green in both lanes; commit.

**AC:** counters/timings observable via the route; interrupted-runs and embeds-per-turn each proven by one integration assertion; mutation: removing the `upsertSourceDoc` bump fails a test.

### Task 2: Payload strip - onnxruntime-web and types (QW2) + per-leg platform prune (QW3)

Body carries: `ALLOW-PROTECTED: .github/workflows/release-build.yml`

**Files:**
- Modify: `scripts/build-server.mjs` (strip block next to the existing CUDA strip), `.github/workflows/release-build.yml` (per-leg prune step before `tauri build`)
- Create: `scripts/prune-platform.mjs` (~30 lines, keyed on an explicit `--keep win-x64|linux-x64|darwin-arm64` arg so it is testable off-CI)
- Test: `tests/build-payload.test.ts`

**Steps:**
- [ ] Failing test: seed a fake payload dir with `node_modules/onnxruntime-web/x.wasm`, `node_modules/@types/node/x.d.ts`, `onnxruntime-node/bin/napi-v6/{win32-x64,linux-x64,darwin-arm64}/f.so`, `@img/sharp-{win32-x64,linux-x64}/y`; run the strip fn → onnxruntime-web and @types gone; run prune `--keep linux-x64` → only linux onnx/sharp dirs remain, ripgrep vendors reduced to one.
- [ ] Implement: unconditional deletes in build-server.mjs (`onnxruntime-web`, `@types`, `undici-types`); `prune-platform.mjs` exports `prunePayload(dir, keep)` and a CLI wrapper.
- [ ] Workflow: one step per leg `node scripts/prune-platform.mjs --keep ${{ matrix.node-target }} --dir app/src-tauri/resources/server`.
- [ ] Smoke: `node scripts/build-server.mjs --out <tmp>` then boot the payload's server.mjs with `EMBED_PROVIDER=fake` and hit `/projects` (401 = alive) — proves transformers.js survives the web-backend removal.
- [ ] Commit.

**AC:** fake-payload test proves both strip and prune; boot smoke proves the sidecar still embeds; workflow lints (yaml valid); mutation: pruning the KEPT platform must fail the test.

### Task 3: Boot snapshot dirty-check (QW9)

**Files:**
- Modify: `src/db/client.ts` (snapshot branch, the comment already marks the upgrade), `src/db/lifecycle.ts` if the clean-shutdown marker helper lives better there
- Test: `tests/embedded-snapshot.test.ts`

**Steps:**
- [ ] Failing test (embedded lane, throwaway VIBEOPS_HOME): boot once (snapshot created), shut down clean, record snapshot mtime, boot again → mtime unchanged (skipped); then simulate unclean (write postmaster.pid before boot) → snapshot recreated.
- [ ] Implement: skip copy when `postmaster.pid` absent at open AND newest snapshot < 24h old (named constant `SNAPSHOT_MAX_AGE_MS`).
- [ ] Tests green in both lanes; commit.

**AC:** both branches proven; mutation: skipping the age check (always skip) must fail the unclean-path test.

## Wave 2 — hot-path hygiene

### Task 4: Per-request DB elimination (QW6a+b+c)

**Files:**
- Modify: `src/api/app.ts` (CORS origins cache), `src/api/auth.ts` (actor cache), `src/services/settings.ts` (invalidate hook on set), `src/services/actors.ts` (invalidate on create/update), `src/api/forge-routes.ts` (fold `sandboxExists`+`lastVerdict` into the tickets listing used by forge.tsx), `src/forge/runs.ts` (`listRunsWithHistory` enrichment → set-based queries), `app/src/routes/forge.tsx` (drop the per-ticket `/sandbox` poll loop)
- Test: `tests/request-caches.test.ts`, extend `tests/forge-api.test.ts`, `app/src/routes/forge.test.tsx`

**Steps:**
- [ ] Failing tests: (a) two requests → `getSetting("cors.origins")` hit once (spy), `setSetting` then request → hit again; (b) same shape for actor resolution keyed by key-hash, invalidated on actor write; (c) tickets listing carries `sandbox: { exists, lastVerdict }` per review ticket; (d) forge.tsx renders review rows without issuing `/forge/tickets/:id/sandbox` calls (mock assertion).
- [ ] Implement: 5-entry TTL(10s) maps — plain `Map` + timestamp, no LRU dep; explicit `invalidate()` exports called by the two writers. Set-based enrichment: one `inArray` query each for verdicts/durations/comments instead of per-row.
- [ ] Both suites green; commit.

**AC:** spy-counted cache behaviour with invalidation proven both sides; the client N+1 is gone by mock assertion; mutation: removing invalidation on `setSetting` must fail (a).

### Task 5: Forge review micro-parallelism + prompt-cache env (QW8)

**Files:**
- Modify: `src/forge/runs.ts` (`Promise.all` diff+summary), `src/forge/gate.ts` (accept precomputed `rangePatch`/`diffNames` params from the one call site), `src/relay/invoke.ts` (spawn env gains `ENABLE_PROMPT_CACHING_1H: "1"` when `process.env.ANTHROPIC_API_KEY` is set)
- Test: extend `tests/forge-runs.test.ts`, `tests/relay-unit.test.ts`

**Steps:**
- [ ] Failing tests: gate receives precomputed inputs (spy: `sandboxRangePatch` called exactly once per review); relay spawn env carries the flag iff API-key auth.
- [ ] Implement; keep gate's signature defaulted so existing tests stay valid.
- [ ] Green; commit.

**AC:** git-spawn count per review drops from 4 to 1 (spy-proven); env flag conditional proven both ways.

### Task 6: Incremental embedding via chunk-hash reuse (QW4)

**Files:**
- Modify: `src/services/knowledge.ts` (`upsertSourceDoc`: diff incoming chunk hashes against existing rows for the ref; delete only missing, embed only new), keep `indexRepoDocs` on the same path (it already flows through upsertSourceDoc)
- Test: extend `tests/chat-ingest.test.ts`, `tests/knowledge-schema.test.ts`

**Steps:**
- [ ] Failing test: ingest a 3-chunk doc, re-ingest with one appended chunk → exactly 1 new embedding created (Task 1's `embed.chunks` counter is the probe), 3 rows reused, 0 deleted; changing chunk 2's text → 1 delete + 1 embed.
- [ ] Implement: `contentHash` per chunk (sha256 of chunk text — column exists), reuse rows whose (ref, hash) match, preserving order index updates.
- [ ] Green in both lanes; commit.

**AC:** append-only turn costs exactly the appended chunks; mutation: reverting to delete-all must fail the counter assertion.

## Wave 3 — frontend

### Task 7: Virtualized output pane (QW7)

Body carries: `ALLOW-PROTECTED: app/package.json, app/package-lock.json`

**Files:**
- Create: `app/src/components/OutputPane.tsx` (react-virtuoso wrapper, `followOutput="smooth"`, chunk-array prop)
- Modify: `app/src/routes/forge.tsx`, `app/src/routes/chat.tsx`, `app/src/routes/create.tsx` (replace the three copy-pasted `setTimeout(10)` scroll blocks and string-concat state with a `string[]` chunks state + `<OutputPane chunks={...}/>`), `app/package.json` (+react-virtuoso)
- Test: `app/src/components/OutputPane.test.tsx`, adjust the three route tests

**Steps:**
- [ ] Failing test: OutputPane renders appended chunks; appending does not remount prior items (key-stability assertion); user-scrolled-up state suppresses auto-follow (virtuoso's followOutput contract, assert via prop wiring).
- [ ] Implement pane; migrate the three routes; delete the three setTimeout scroll blocks.
- [ ] App suite green; commit.

**AC:** all three surfaces render through the one component; no `setTimeout` scroll remains (grep-proven in test); output append no longer re-sets a monolithic string (state shape assertion).

### Task 8: CI regression gates (M7)

**Files:**
- Modify: `.github/workflows/release-build.yml` (size-budget assertion per artifact; latest.json three-platform assertion) — body carries `ALLOW-PROTECTED: .github/workflows/release-build.yml`
- Create: `scripts/assert-release.mjs`
- Test: `tests/assert-release.test.ts`

**Steps:**
- [ ] Failing test: `assertBudget(files, { "setup.exe": 120_000_000, ... })` throws when a file exceeds budget; `assertManifest(latestJson)` throws unless all of darwin-aarch64/windows-x86_64/linux-x86_64 present.
- [ ] Implement script + workflow step after manifest generation.
- [ ] Commit.

**AC:** both assertions unit-proven; budgets set 20% above post-Task-2 measured sizes so drift fails loudly, normal variance does not.

---

## Self-review notes

- Spec coverage: QW1 shipped, QW2/3 → Task 2, QW4 → Task 6, QW6 → Task 4, QW7 → Task 7, QW8 → Task 5, QW9 → Task 3, M1-M4 → Task 1, M7 → Task 8. QW5 deferred by decision, M5 already exists (`ai_usage_logs` + stage durations), M8/M9 are measurement-owned, not code tasks.
- Interfaces: Task 6's probe consumes Task 1's `embed.chunks` counter — Wave 1 before Wave 2 ordering is load-bearing.
- No placeholder scan: each task names exact files, real assertions, and its mutation.
