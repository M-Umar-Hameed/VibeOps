# Phase 3 — Tauri Desktop App (Design Spec)

## Context

Phases 1-2 built the server: a self-hosted Postgres ticket engine with transactions, optimistic concurrency, per-actor auth, an append-only audit trail, and a pgvector knowledge/memory layer — all reachable over one REST API and one MCP server through a single service layer. Phase 3 adds a desktop UI so humans (not just AI agents) can drive it.

The app is a **pure client**: zero business logic, no local database, no direct DB access. Everything goes through the existing REST API. All state, auditing, locking, and workflow stay on the server. If the app has a bug, the data is still safe.

Stack matched to the existing `D:\Github\monorepo` Tauri app: Tauri 2, React 18, Vite, TypeScript, Vitest, TanStack Query, TanStack Router, `@tauri-apps/plugin-http`, `@tauri-apps/plugin-store`, lucide-react.

## Scope of this slice (decided during brainstorming)

- Screens: ticket **list** (filter + keyword search), ticket **detail** (view/edit + comments + audit timeline), **create ticket**, **knowledge** panel (search + save-note), **settings**.
- Transport: `@tauri-apps/plugin-http` (Rust-side HTTP, bypasses browser CORS — no server CORS change).
- Credentials: server URL + API key entered in a first-run settings screen, persisted via `@tauri-apps/plugin-store` (plain JSON in the app data dir — acceptable for a local internal tool).
- Freshness: TanStack Query `refetchOnWindowFocus`, no interval polling; graceful 409 recovery on concurrent edits.
- Server additions (the only Phase 1/2 server change): `GET /projects`, `POST /projects`, `GET /actors` — read/create through the service layer, bearer-auth, `GET /actors` never leaks `apiKeyHash`.
- Out of scope: kanban board, Tauri WebDriver E2E, actor/API-key creation from the UI (security-sensitive bootstrap — stays a CLI/script), interval polling, offline mode, multi-window.

## Architecture

App lives in the same repo under `app/`. Rust side is thin: register the http + store plugins, nothing else — no business logic in Rust.

```
app/
  src-tauri/            Tauri 2 config + main.rs (register plugin-http, plugin-store)
  src/
    api/
      client.ts         base fetch via plugin-http: inject bearer + base URL, map errors
      errors.ts         AuthError, NotFoundError, StaleVersionError, ApiError
      tickets.ts        list/get/create/update
      comments.ts       add
      history.ts        get
      knowledge.ts      search
      notes.ts          save
      projects.ts       list/create
      actors.ts         list
      types.ts          hand-written row types mirroring server rows
    settings.ts         load/save { baseUrl, apiKey } via plugin-store
    routes/             list, detail, create, knowledge, settings screens
    components/         ticket-row, status-badge, audit-timeline, comment-list, banner
    main.tsx            router + QueryClient + first-run settings gate
```

## Server additions (existing `src/api/app.ts` + `src/services/`)

Only the app-lookup endpoints, all behind the existing `auth` middleware:
- `GET /projects` → `listProjects()` → `Project[]`.
- `POST /projects` (`{ key, name }`) → `createProject(input)` → `Project`. No audit event (projects were never an audited entity in Phase 1; consistent with test seeding). A duplicate `key` (DB unique violation) is caught in the service and rethrown as a typed `ConflictError` mapped to HTTP 409 with a clear message ("project key already exists"); the app shows it inline on the create-project field.
- `GET /actors` → `listActors()` → `{ id, name, kind, role }[]` — **never** `apiKeyHash`.

New service functions in `src/services/projects.ts` and `src/services/actors.ts` (extend the existing actors service) keep the routes thin. These are read/simple-create; no transaction/audit machinery needed beyond a plain insert for `createProject`.

## API client layer

`client.ts` is the only module that knows HTTP exists.
- Reads `{ baseUrl, apiKey }` from settings on every call, so changing settings takes effect without a restart.
- Injects `Authorization: Bearer <apiKey>`.
- Sends/parses JSON; maps non-2xx to typed errors: 401→`AuthError`, 404→`NotFoundError`, 409→`StaleVersionError`, other→`ApiError` (carrying status + message). A network/connection failure → `ApiError` with a "cannot reach server" marker.

Resource modules are thin typed wrappers over `client`:
- `tickets.list(filter?: { projectId?; status? })`, `tickets.get(id)`, `tickets.create(input)`, `tickets.update(id, expectedVersion, patch)`
- `comments.add(ticketId, body)`, `history.get(ticketId)`
- `knowledge.search(query, limit?)`, `notes.save({ body, scope, refId? })`
- `projects.list()`, `projects.create({ key, name })`, `actors.list()`

Types in `types.ts` are hand-written to match server rows (small surface, no codegen).

## State / data flow (TanStack Query)

- Query keys: `['tickets', filter]`, `['ticket', id]`, `['history', id]`, `['projects']`, `['actors']`, `['knowledge', query]`.
- `refetchOnWindowFocus: true` globally; no interval polling.
- Mutations invalidate the relevant keys on success: `update`/`create` → `['tickets']` + `['ticket', id]`; `addComment` → `['ticket', id]` (comments + history); `saveNote` → `['knowledge']` (optional).
- **409 recovery (load-bearing):** `tickets.update` sends the `expectedVersion` from the loaded ticket. On `StaleVersionError`, the mutation `onError` shows a non-destructive banner ("This ticket changed elsewhere — reloaded; please redo your edit"), invalidates `['ticket', id]` to pull the fresh version, and KEEPS the user's unsaved form input so they can re-apply and resubmit against the new version. Ticket edits are never optimistically applied — not clobbering concurrent writers is the whole point of the system.
- Append-only actions (comments, save-note) may be lightly optimistic (append, roll back on error) — no version conflict possible.

## Screens

- **Settings (first-run gate):** if no stored key/URL, the app opens here. Fields: server URL (default `http://localhost:8787`), API key. "Test connection" → `GET /projects` (200 good, 401 bad key). Persist via plugin-store, then unlock.
- **Ticket list:** project dropdown (`/projects`) + status filter; keyword box → `GET /search`. Rows: title, status badge, priority, assignee name (via `/actors`), updated-at. Row click → detail.
- **Ticket detail:** title/body; status, priority, assignee (dropdown from `/actors`) editable; Save → `tickets.update` with `expectedVersion` (409 flow above). Comments list with author names + add-comment box (append-optimistic). Audit timeline from `/history`: per event — actor name, action, changed fields (from→to), timestamp.
- **Create ticket:** project picker (`/projects`) with inline "New project" (`POST /projects`); title, body, priority, optional assignee → `POST /tickets` → navigate to detail.
- **Knowledge panel:** search box → `GET /knowledge` → result cards (content snippet + source citation). Save-note form: body + scope (global/project/ticket; project/ticket reveals a ref picker) → `POST /notes`.

## Error handling (app never crashes on an API error)

- Server unreachable → app-level banner "can't reach server — check Settings".
- 401 → bounce to Settings with "key rejected".
- 409 → the ticket-detail recovery banner.
- 404 → "not found / was deleted", return to list.
- Other → toast with the error message.

## Testing

- **API client layer (highest value):** Vitest unit tests with a mocked `plugin-http` fetch — assert bearer injection, base-URL usage, and error mapping (401/404/409/other → typed errors; connection failure → ApiError).
- **Components:** React Testing Library — ticket-detail Save calls `update` with `expectedVersion`; a 409 shows the banner and preserves form input; create-ticket posts and navigates; knowledge search renders result cards. The `api/` modules are mocked.
- **Server additions:** extend the Phase 1 vitest suite (live Postgres on 5433) — `GET/POST /projects` and `GET /actors` require auth (401 without); `POST /projects` creates and is listed; `GET /actors` response contains no `apiKeyHash`.
- No Tauri WebDriver E2E this slice. Manual smoke: `tauri dev` against a running server — create project + ticket, comment, view history, search + save knowledge, and confirm a concurrent edit (via a second client / curl) triggers the 409 banner.

## Acceptance

- Fresh install → Settings → connect → create a project → create a ticket → edit its status → add a comment → see all of it in the audit timeline with actor attribution.
- A ticket edited by another client while open triggers the 409 banner, reloads, and lets the user re-apply without losing input.
- Knowledge search returns results with citations; a saved note becomes searchable.
- Server additions: full server suite + typecheck green; `GET /actors` never exposes key hashes. App: client-layer + component tests green.

## Deferred to later slices
- Kanban board view.
- Tauri WebDriver end-to-end tests.
- Actor / API-key management UI.
- Interval polling / live updates.
- GitHub sync (Phase 4).
