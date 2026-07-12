# Frontend/Backend Wiring (Design Spec)

## Context

Recent server phases shipped capabilities the app doesn't surface yet: the MCP connect endpoints (P9 card exists but is unwired — the MCP settings tab renders mock servers), the note workspace (P11 REST has no UI and the app's notes api client only has `save`), and cross-tool session ingestion (P10) which is CLI-only — and the CLI cannot run while the desktop app's sidecar holds the embedded PGlite (single-process), so the installed app literally cannot ingest sessions today. User asked for this phase ("look up the frontend and backend wiring — work on this phase as well"). Decided autonomously.

## Design

Three slices, smallest that closes each gap:

1. **Ingest-over-REST (server):** `POST /ingest/sessions` (body: `{ sinceDays? }`) runs `ingestSessions([all four sources], getEmbedder(), sinceDays ?? 30)` IN the server process and returns the per-source `{ indexed, skipped, failed }` summary. Long-running (embedding): acceptable as a synchronous request for now — the client shows a busy state; document a 10-minute client timeout expectation. No new process, so the PGlite constraint is satisfied by construction.
2. **MCP tab wiring (app):** `MCPTab.tsx` renders `McpConnectCard` (real) above the existing mock-server grid (leave the mocks — they're the user's visual direction for future connectors; label them "coming soon" only if trivial within existing styles).
3. **Notes workspace UI (app):** extend `app/src/api/notes.ts` with `list/get/update/remove` calling the P11 endpoints (409-aware like tickets); add a "Notes" panel into the existing knowledge route (`app/src/routes/knowledge.tsx`) — list (title-or-body-snippet, scope badge), inline edit (textarea + title input, expectedVersion from the loaded note, 409 → refetch-and-preserve-edit pattern copied from the ticket detail screen), delete with confirm, create with title. Plus a "Sync sessions" button (calls the new ingest endpoint, shows the per-source summary) placed in the knowledge route header.

## Approaches considered

1. Chosen: wire into existing screens (knowledge route + MCP tab) — no new routes, matches the user's information architecture.
2. New dedicated "/notes" route — cleaner but invents IA the user (who owns the frontend design) hasn't asked for.
3. Ingest as a background job with polling — YAGNI now; synchronous with busy state is honest and simple, and the endpoint shape doesn't change if a job queue arrives later.

## Error handling

Ingest endpoint: per-source failures are already counted in the summary (never throws for source errors); embedder init failure → existing 500 mapping. Notes UI: 409 on stale edit refetches and preserves the user's draft (same pattern as ticket detail); 400s surface message inline.

## Testing

Server: ingest endpoint test with fake embedder + temp HOME sources (point codex/antigravity/claude readers at temp dirs via a test that calls the route with injected sources? — the route uses default sources; test asserts 200 + summary shape and auth 401; source-level behavior is already unit-tested per reader). App: component tests for the notes panel (list renders, edit sends expectedVersion, 409 recovery keeps draft, delete confirm) and MCPTab renders the card — mock apiFetch per existing app test conventions.

## Out of scope

Background job queue, ingest progress streaming, notes markdown rendering, mock-server removal/redesign in MCP tab, Obsidian card changes (already wired by the user).
