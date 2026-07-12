# Frontend/Backend Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app surfaces what the server already does: MCP connect card mounted, notes workspace UI (list/edit/delete/create with 409 recovery), and a session-sync button backed by a new in-process ingest endpoint.

**Architecture:** One new server route (`POST /ingest/sessions`) reusing `ingestSessions` in-process (PGlite single-process satisfied by construction). App work follows existing conventions exactly: `apiFetch` clients in `app/src/api/*`, react-query with the global 401 handling, the ticket-detail 409 edit-preservation pattern, existing glass-card styling.

**Tech Stack:** Hono route; React 19 + @tanstack/react-query; existing app test conventions (vitest + mocked apiFetch via `setFetchImpl`/module mocks — read a neighboring test first).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-12-fe-be-wiring-design.md`.
- Server: the ingest route runs IN-PROCESS (never spawn); returns the per-source summary object exactly as `ingestSessions` produces it.
- App: match committed styling conventions (`glass-card`, `material-symbols-outlined`, existing button/input classes — copy from committed IntegrationsTab/detail route). Notes edit MUST send `expectedVersion` and on 409 refetch-preserving-draft (copy the pattern from `app/src/routes/detail.tsx`).
- Stage ONLY files your task names. Never push. Docker PG :5433 for the root suite; app suite is `cd app && npm test`.

---

### Task 1: `POST /ingest/sessions` (server)

**Files:**
- Modify: `src/api/app.ts` (one route)
- Test: `tests/ingest-api.test.ts` (create)

**Interfaces:**
- Consumes: `ingestSessions` + the four `make*Source` factories from `src/ingest/sessions/*` (read `src/ingest/sessions/cli.ts` — the route mirrors its wiring), `getEmbedder`.
- Produces: `POST /ingest/sessions` body `{ sinceDays?: number }` → 200 `{ [source]: { indexed, skipped, failed } }`. Task 3's UI calls it.

- [ ] **Step 1: Write the failing test**

Create `tests/ingest-api.test.ts` following the auth conventions of an existing API test (read `tests/notes-api.test.ts` first and mirror its bootstrap/header helper):

Cases: (a) unauthenticated POST → 401; (b) authenticated POST with `{ sinceDays: 0 }` → 200 and body has keys `claude-mem`, `claude-code`, `codex`, `antigravity`, each `{ indexed: number, skipped: number, failed: number }` (sinceDays 0 makes every reader return[]-ish quickly — no real ingestion in the suite); (c) `EMBED_PROVIDER=fake` is already the suite's env — assert nothing downloads (implicit: test completes fast).

- [ ] **Step 2: Run to verify failure** — Expected: 404.

- [ ] **Step 3: Implement the route in `src/api/app.ts`**

```ts
app.post("/ingest/sessions", async (c) => {
  const { sinceDays } = await c.req.json().catch(() => ({}));
  const days = Number.isFinite(Number(sinceDays)) && Number(sinceDays) >= 0 ? Number(sinceDays) : 30;
  const { ingestSessions } = await import("../ingest/sessions/ingest.js");
  const { makeClaudeMemSource } = await import("../ingest/sessions/claude-mem.js");
  const { makeClaudeCodeSource } = await import("../ingest/sessions/claude-code.js");
  const { makeCodexSource } = await import("../ingest/sessions/codex.js");
  const { makeAntigravitySource } = await import("../ingest/sessions/antigravity.js");
  const summary = await ingestSessions(
    [makeClaudeMemSource(), makeClaudeCodeSource(), makeCodexSource(), makeAntigravitySource()],
    getEmbedder(), days,
  );
  return c.json(summary);
});
```

NOTE: verify the actual module path/export of `ingestSessions` by reading `src/ingest/sessions/cli.ts` — if the engine lives elsewhere (e.g. exported from cli.ts itself or an `ingest.ts`), import from the real location; if it only lives in cli.ts alongside the entrypoint, extract nothing — import from cli.ts is fine ONLY if importing it has no side effects (check for a main-module guard); otherwise move the engine function to `src/ingest/sessions/ingest.ts` and have cli.ts import it (mechanical move, keep cli.ts's behavior identical). Dynamic imports keep server boot light. `getEmbedder` may already be imported in app.ts — check.

- [ ] **Step 4: Run tests** — new test passes; `npm test && npx tsc --noEmit` green.

- [ ] **Step 5: Commit**

```bash
git add src/api/app.ts tests/ingest-api.test.ts   # + src/ingest/sessions/* if the engine moved
git commit -m "feat: in-process session ingest endpoint"
```

---

### Task 2: Notes API client + workspace UI (app)

**Files:**
- Modify: `app/src/api/notes.ts` (extend), `app/src/api/types.ts` (Note type gains title/version/deletedAt if missing), `app/src/routes/knowledge.tsx` (notes panel)
- Test: `app/src/routes/knowledge.test.tsx` (extend) or a new `app/src/components/NotesPanel.test.tsx` — follow whichever convention the existing knowledge test uses.
- Create (if cleaner): `app/src/components/NotesPanel.tsx`

**Interfaces:**
- Consumes: server REST from P11: `GET /notes?scope=&refId=&limit=`, `GET /notes/:id`, `PATCH /notes/:id` `{expectedVersion,title?,body?}` (409 stale), `DELETE /notes/:id` `{expectedVersion}`, `POST /notes` `{body,scope,refId?,title?}`.
- Produces: `notes` client object with `list(filter?)`, `get(id)`, `save(input)`, `update(id, expectedVersion, patch)`, `remove(id, expectedVersion)`; `NotesPanel` component mounted in the knowledge route.

- [ ] **Step 1: Extend `app/src/api/notes.ts`**

```ts
import { apiFetch } from "./client.js";
import type { Note } from "./types.js";
export const notes = {
  list: (filter: { scope?: string; refId?: string; limit?: number } = {}) =>
    apiFetch("/notes", { query: { scope: filter.scope, refId: filter.refId, limit: filter.limit?.toString() } }) as Promise<Note[]>,
  get: (id: string) => apiFetch(`/notes/${id}`) as Promise<Note>,
  save: (input: { body: string; scope: string; refId?: string; title?: string }) =>
    apiFetch("/notes", { method: "POST", body: input }) as Promise<Note>,
  update: (id: string, expectedVersion: number, patch: { title?: string; body?: string }) =>
    apiFetch(`/notes/${id}`, { method: "PATCH", body: { expectedVersion, ...patch } }) as Promise<Note>,
  remove: (id: string, expectedVersion: number) =>
    apiFetch(`/notes/${id}`, { method: "DELETE", body: { expectedVersion } }) as Promise<{ ok: boolean }>,
};
```

Ensure `Note` in `app/src/api/types.ts` includes `title: string | null; version: number;`.

- [ ] **Step 2: Write failing component tests** — following the existing knowledge.test.tsx mock conventions: list renders note titles/snippets; edit submit calls `notes.update` with the loaded `version` as expectedVersion; on a mocked `StaleVersionError` the draft text stays in the textarea and the note is refetched; delete asks confirm then calls `notes.remove`; create with title calls `notes.save`.

- [ ] **Step 3: Implement `NotesPanel` + mount in knowledge route** — list (newest first) with scope badge and title-or-first-line, per-note expand → edit form (title input + body textarea + Save sending expectedVersion + Delete with `window.confirm`), "New note" form (title optional, body required, scope fixed "global" for now). 409 recovery: catch `StaleVersionError`, refetch the note, keep the draft, show "Note changed elsewhere — review and save again" inline (copy tone from detail.tsx). Add a "Sync sessions" button in the knowledge route header calling `apiFetch("/ingest/sessions", { method: "POST", body: {} })` with a busy spinner and a result line like `codex 1 · claude-code 38 · …` from the summary (compact, existing text styles).

- [ ] **Step 4: Run app tests + typecheck + build** — `cd app && npm test && npx tsc --noEmit && npm run build` — all green.

- [ ] **Step 5: Commit**

```bash
git add app/src/api/notes.ts app/src/api/types.ts app/src/routes/knowledge.tsx app/src/routes/knowledge.test.tsx app/src/components/NotesPanel.tsx
git commit -m "feat: notes workspace panel and session sync in the knowledge screen"
```

---

### Task 3: Mount McpConnectCard (app)

**Files:**
- Modify: `app/src/components/settings/MCPTab.tsx`
- Test: `app/src/routes/settings.test.tsx` (extend only if it already asserts tab content; otherwise a minimal render test is enough — follow the existing convention).

**Interfaces:**
- Consumes: existing `McpConnectCard` (app/src/components/settings/McpConnectCard.tsx — default-export/named per the file; read it).

- [ ] **Step 1:** Import and render `<McpConnectCard />` at the top of MCPTab's content, above the mock-server grid (mocks stay — they are the user's visual direction).
- [ ] **Step 2:** `cd app && npm test && npx tsc --noEmit && npm run build` — green; if a settings test asserts tab content, update it.
- [ ] **Step 3: Commit**

```bash
git add app/src/components/settings/MCPTab.tsx app/src/routes/settings.test.tsx
git commit -m "feat: mount MCP connect card in the MCP settings tab"
```

---

## Final steps (controller)

Live check: boot dev server + `npm run dev` in app (or reuse test evidence), click-path optional — REST-level verification acceptable: POST /ingest/sessions returns summary; notes CRUD over the UI's exact calls. Whole-branch review (sonnet), fix wave, gates (root + app suites), ledger + memory.
