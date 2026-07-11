# Phase 4 — Inbound Sync Framework + GitHub Connector (Design Spec)

## Context

Phases 1-3 built the audited ticket engine, knowledge layer, and desktop client. Phase 4 lets tickets **originate in external systems** and flow into the audited engine. Tickets can come from GitHub, GitLab, Jira, Asana, an RMM, or any tool exposing an API or MCP server — but each source is its own subsystem, so this slice builds the **framework once** plus **one reference connector (GitHub)**. Every other source is a later slice implementing the same interface.

The engine stays authoritative for *workflow and audit*: imports are writes through the existing service layer, so every synced ticket/comment lands in the same append-only audit trail as human and AI writes. Sync is **one-way inbound and poll-based** (poll is the only mechanism every future source type — including MCP and non-webhook APIs — can share; the LAN/VPS server also isn't necessarily publicly reachable for webhooks).

## Scope of this slice (decided during brainstorming)

- The `SourceConnector` interface + a source-agnostic import engine + the GitHub reference connector + a poll CLI.
- One-way inbound: external → tickets. The source is authoritative for the fields of tickets it owns.
- Poll-based (`npm run sync:github`, manual or cron). No webhooks/daemon.
- Field mapping v1: title, body, status (open/closed). Priority defaults `normal`; assignee left unset (identity mapping deferred). Comments imported one-way (new only).
- Out of scope: GitLab/Jira/Asana/RMM/MCP-source/generic-API connectors (each a later slice on the same interface); outbound/two-way sync; webhooks; assignee/identity mapping; label/custom-field sync; external comment edit/delete mirroring; a config table (config via env/args); an MCP/REST "sync now" trigger.

## Architecture

```
src/sync/
  connector.ts            SourceConnector interface + ExternalTicket type
  import.ts               runSync(connector, { projectId }) — source-agnostic engine
  actor.ts                resolveSyncActor(source) — idempotent "sync:<source>" actor
  connectors/github.ts    makeGithubConnector(octokit, repo) — GitHub reference connector
  cli.ts                  `npm run sync:github` entrypoint
```

The connector's only job: talk to its source and return normalized `ExternalTicket[]`. It knows nothing about Postgres, dedup, or audit — the import engine owns all of that. That boundary is why the next connector is thin.

```ts
export interface SourceConnector {
  source: string;                     // "github", "gitlab", "mcp:foo", ...
  listExternalTickets(since?: Date): Promise<ExternalTicket[]>;
}
export type ExternalComment = { externalId: string; author: string; body: string; createdAt: string };
export type ExternalTicket = {
  externalId: string;                 // stable id, e.g. "owner/repo#12"
  title: string;
  body: string;
  status: "open" | "in_progress" | "closed";
  updatedAt: string;                  // ISO; drives the incremental cursor
  comments: ExternalComment[];
};
```

## Data model

Two mapping tables (dedup truth) — no embeddings, no audit machinery of their own; the audit lives in `events` via the import writes.

### `sync_links` (external ticket → internal ticket)
- `id` uuid pk
- `source` text not null
- `externalId` text not null
- `ticketId` uuid not null → tickets(id)
- `externalUpdatedAt` timestamptz — last-seen source update time (incremental cursor + skip-unchanged)
- `createdAt` timestamptz not null default now()
- Unique on `(source, externalId)`

### `sync_comment_links` (external comment → internal comment)
- `id` uuid pk
- `source` text not null
- `externalId` text not null
- `commentId` uuid not null → comments(id)
- `createdAt` timestamptz not null default now()
- Unique on `(source, externalId)`

### Sync actor
Imports are audited writes, so they run under a dedicated actor per source. `resolveSyncActor(source)` finds-or-creates an actor `name = "sync:<source>"`, `kind = "agent"` (idempotent by name). Its API key is never used for auth — it exists purely for audit attribution, so the trail shows exactly which sync brought each ticket/comment in.

## Data flow — `runSync(connector, { projectId })`

1. Resolve the sync actor for `connector.source`.
2. Incremental cursor: `since` = max `externalUpdatedAt` in `sync_links` for this source (null on first run). `connector.listExternalTickets(since)`.
3. Per `ExternalTicket`, look up `sync_links(source, externalId)`:
   - **New** → `createTicket(syncActor.id, { projectId, title, body })`, then `updateTicket` to set status if not `open` (createTicket defaults status `open`); insert `sync_link` with `externalUpdatedAt`.
   - **Existing, `externalUpdatedAt <= stored`** → skip (no write).
   - **Existing, newer** → fetch current ticket, `updateTicket(id, version, { title, body, status })`; on `StaleVersionError` refetch version and retry once, still stale → log + skip; update `sync_link.externalUpdatedAt` on success.
4. Comments: for each `ExternalComment`, check `sync_comment_links(source, externalId)`; only new → `addComment(syncActor.id, ticketId, body)` → insert link.
5. Per-ticket failures are logged and skipped (one bad ticket never aborts the run); return `{ created, updated, skipped, commentsAdded, failed }`.

Status mapping: sources without `in_progress` (GitHub) yield only `open`/`closed`. One-way authority: synced fields are overwritten from the source on each run; local-only tickets (no `sync_link`) are never touched.

## GitHub connector — `makeGithubConnector(octokit, repo)`

- `source = "github"`. Config: `GITHUB_TOKEN`, `SYNC_GITHUB_REPO` (`owner/name`), `SYNC_GITHUB_PROJECT`.
- `listExternalTickets(since?)`: list repo issues `state=all`, pass `since` through (GitHub's incremental filter), auto-paginate via `octokit.paginate`.
- **Filter out pull requests** (issues endpoint returns PRs; skip any with a `pull_request` field).
- Map issue → `ExternalTicket`: `externalId = "owner/repo#<number>"`, title, `body = issue.body ?? ""`, `status = issue.state === "closed" ? "closed" : "open"`, `updatedAt = issue.updated_at`.
- Fetch issue comments (paginated) → `ExternalComment` (`externalId = "owner/repo#comment-<id>"`, author `login`, body, `createdAt`).
- Octokit is injected (`makeGithubConnector(octokit, repo)`) so tests pass a fake — no real GitHub, no token in CI.

## Mechanism

`src/sync/cli.ts` — `npm run sync:github`: builds the GitHub connector from env, runs `runSync` against `SYNC_GITHUB_PROJECT`, prints the result, exits. Windows-safe `pathToFileURL(process.argv[1])` entrypoint guard. Run manually or via cron. Poll-based; no webhook/daemon.

## Error handling

Idempotent + incremental → every run is safely resumable.
- Connector API failure (GitHub down / rate-limited) → abort with a clear error; committed `sync_links` mean the next run resumes from the cursor.
- Per-ticket failure → log + skip, continue.
- 409 mid-run → retry once with fresh version, then skip (next run catches it).

## Testing (live Postgres 5433; fakes for all external I/O)

- **Import engine** with a fake in-memory connector: first run creates tickets + `sync_links` + `events` attributed to `sync:<source>`; re-run unchanged → skips (no duplicate tickets); bumped `externalUpdatedAt` → updates the ticket; a new external comment → `addComment` once, re-run → no dup comment (`sync_comment_links`).
- **409 path**: a fake service scenario where `updateTicket` throws `StaleVersionError` once then succeeds → assert retry-then-success.
- **GitHub connector** with a fake Octokit whose list includes a PR → assert the PR is filtered and issues/comments map correctly (externalId, status, comment shape).
- **Sync-actor idempotency**: two `runSync` calls reuse one `sync:github` actor (no duplicate actor rows).
- Reuse the server vitest + live Postgres.

## Acceptance

- A fake connector's tickets import as audited tickets under `sync:<source>`; re-running is idempotent (no dup tickets/comments); an updated external ticket updates the internal one; a concurrent local edit (409) is retried once then skipped.
- The GitHub connector filters PRs and maps issues + comments correctly against a fake Octokit.
- `npm run sync:github` runs end-to-end against a real repo (manual check with a token).
- Full server suite + typecheck green.

## Deferred to later slices
- Additional connectors (GitLab, Jira, Asana, RMM, MCP-source, generic-API) — each implements `SourceConnector`.
- Outbound / two-way sync; webhooks; assignee/identity mapping; labels/custom fields; external comment edit-delete mirroring; a config table; an MCP/REST "sync now" trigger.
