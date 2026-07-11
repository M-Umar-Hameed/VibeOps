# Phase 2 — Knowledge / RAG + Writeable Memory (Design Spec)

## Context

Phase 1 gave the tickets system real transactions, optimistic concurrency, per-actor auth, schema, and an append-only audit trail, reachable identically by REST and MCP through one service layer. Phase 2 adds the knowledge layer on top of that same Postgres instance so every session and every AI tool (Claude Code/Cowork, Gemini, Codex, Cursor) shares one synced brain.

Two capabilities, one pipeline:
- **Doc retrieval (read-only RAG):** the Obsidian vault is ingested into pgvector so agents can retrieve SOPs / asset / infra docs. The vault stays the source of truth; pgvector holds a rebuildable projection.
- **Writeable session memory:** a `notes` table lets agents deliberately persist durable facts/decisions and read them back in later sessions. Written through the audited service layer, then embedded into the same searchable index.

Guiding principle carried from Phase 1: **truth vs retrieval.** Authoritative records live in Postgres tables (transactional, audited, lossless). pgvector holds embeddings — a projection rebuildable from the truth, never the sole record.

Cross-tool sync is achieved by everything pointing at one Postgres (`DATABASE_URL`) and reaching it through the MCP server. There is no local memory *file* to reconcile.

## Scope of this slice (decided during brainstorming)

- Sources: **vault only.** GitHub and URL ingestion are deferred to later slices, added behind the same adapter interface.
- Memory writes: **explicit `save_note` only** (no agent auto-capture yet).
- Retrieval surface: **one `search_knowledge` tool** over everything (vault + notes) + **`save_note`**. `related_to_ticket` deferred.
- Embedder: **pluggable**, one active provider at a time, default Voyage `voyage-3`.
- Ingestion: **live chokidar watcher** (own process) + full-index on startup.
- Out of scope: GitHub/URL adapters, auto-capture memory, per-ticket auto-surfacing, reranking, hybrid keyword+vector fusion, the Tauri app (Phase 3), GitHub sync (Phase 4).

## Architecture

New code areas, all reusing the Phase 1 service-layer + audit pattern:

- `src/knowledge/embedder.ts` — pluggable `Embedder` (default Voyage); dimension pinned by config.
- `src/knowledge/chunker.ts` — heading-aware markdown chunking (pure, no I/O).
- `src/services/notes.ts` — `saveNote` (writeable memory, audited + embedded) and note reads.
- `src/services/knowledge.ts` — `searchKnowledge` (vector similarity over the unified index).
- `src/ingest/watch.ts` — standalone chokidar watcher CLI; connects to the same Postgres + embedder.
- MCP: extend the existing `buildServer` with `save_note` + `search_knowledge`.
- REST: add `POST /notes` and `GET /search?q=` (parity — Phase 1 established REST+MCP over one service layer).

The watcher is just another DB client. It needs the vault filesystem, `DATABASE_URL`, and the embedding key — it does NOT need to be co-located with the API server. Runs on the machine that holds the vault; talks to Postgres wherever that lives.

## Data model

Enable the pgvector `vector` extension.

### `notes` (authoritative writeable memory)
- `id` uuid pk
- `actorId` uuid not null → actors(id)
- `body` text not null
- `scope` enum `global | project | ticket` not null
- `refId` uuid nullable — the project or ticket id when scope is `project`/`ticket`; null for `global`
- `indexed` boolean not null default false — set true after a successful embedding upsert
- `createdAt` timestamptz not null default now()

### `embeddings` (unified searchable projection — rebuildable)
- `id` uuid pk
- `sourceKind` enum `vault | note` not null
- `sourceRef` text not null — vault file path, or the note id
- `chunkIndex` integer not null
- `content` text not null — the chunk text
- `embedding` vector(N) not null — N fixed at migration from the configured model's dim
- `model` text not null
- `dim` integer not null
- `contentHash` text not null — per-source-file hash for change detection
- `createdAt` timestamptz not null default now()
- Unique on `(sourceKind, sourceRef, chunkIndex)`
- Vector index (hnsw or ivfflat) on `embedding`

### `events` migration (unify audit across tickets and notes)
Phase 1 `events.ticketId` is NOT NULL. Notes must be audited too, so:
- make `events.ticketId` nullable
- add `events.noteId` uuid nullable → notes(id)
- add CHECK: `ticketId IS NOT NULL OR noteId IS NOT NULL`

Existing rows and all Phase 1 insert paths always set `ticketId`, so they remain valid. This keeps ONE append-only audit for the whole system rather than two.

## Data flow

### Vault ingestion (`src/ingest/watch.ts`)
1. **Startup full-index:** walk `VAULT_PATH` for `.md` files. For each, compute a content hash; compare to the `contentHash` on that file's existing `embeddings` rows. Unchanged → skip (no API cost). New/changed → chunk → embed → replace that file's chunks.
2. **Startup note sweep:** embed any `notes` where `indexed = false` (stragglers from prior embedding failures), set `indexed = true`.
3. **Watch:** chokidar on the vault:
   - `add` / `change` → re-chunk that one file, delete its old `embeddings` rows, insert new (hash-gated: a save with no content change is a no-op).
   - `unlink` → delete all `embeddings` rows where `sourceKind='vault'` and `sourceRef` = that file (stale docs must leave the index).
4. **Chunking:** split on markdown headings, then size-cap each section (target a few hundred tokens) so a huge section splits further. Each chunk carries file path + chunk index.
5. **Embedding:** batch a file's chunks into one embedder call. Store `model` + `dim` per row.
6. Debounce rapid saves (editors fire multiple events) so one save = one reindex. A single bad file is logged and skipped — never crashes the watcher.

Notes are NOT ingested by the watcher; they embed at write time (below).

### Save note (`saveNote`)
One flow, memory never lost to a flaky embedding API:
1. In a transaction: insert `notes` row (`indexed=false`) → insert `events` audit row (`action: "note.saved"`, `noteId` set). If scope is `project`/`ticket`, validate `refId` exists first (else `NotFoundError`); `global` needs no refId.
2. After the transaction commits: embed the body and upsert into `embeddings` (`sourceKind='note'`, `sourceRef=note.id`), then set `indexed=true`. On embedding failure: leave `indexed=false` and return the note anyway — the next watcher startup sweep re-embeds it. The note (truth) is never lost.

### Search (`searchKnowledge`)
1. Embed the query with the active embedder.
2. Cosine-nearest over `embeddings`, filtered to rows whose `dim` matches the active model (a half-migrated store never returns garbage).
3. Optional `scope` filter narrows note results by ticket/project; vault is always searchable.
4. Return raw chunks `{ content, sourceKind, sourceRef, score }` + a citation string. The agent synthesizes; the service does not.

## Embedder abstraction

- Interface: `Embedder { embed(texts: string[]): Promise<number[][]>; model: string; dim: number }`.
- Env: `EMBED_PROVIDER=voyage|openai|gemini`, `EMBED_MODEL`, provider API key, `VAULT_PATH`.
- `dim` from a model→dim lookup; unknown model → fail fast at startup.
- `embeddings.embedding` is `vector(N)`, N fixed at migration from the configured model's dim. Switching provider/dim = new migration + full re-embed, documented explicitly — mixed-dim rows are not supported; search filters to the active dim.
- Default: Voyage `voyage-3` (1024).

## Error handling

- Watcher: per-file failures logged and skipped; watcher never crashes on one bad file. Embedding-API outage during full-index leaves affected files un-indexed for the next run (hash-gate re-attempts them).
- `saveNote`: embedding failure keeps the note, `indexed=false`, audited; reconciled by the startup sweep.
- `searchKnowledge`: embedding-API failure surfaces as an error to the caller (no silent empty result).
- Dim mismatch: rows not matching the active `dim` are excluded from search rather than compared.
- Notes reuse Phase 1 typed errors (`NotFoundError` for bad `refId`).

## Testing

- **Chunker:** pure unit — heading split + size cap, no DB/API.
- **Fake embedder:** deterministic stub vectors for all DB/logic tests → zero API calls in CI; one live smoke test gated behind an env flag.
- **Ingestion:** temp dir + sample `.md` → index → assert `embeddings` rows; edit → re-embed; delete → chunks gone; unchanged → hash-gate skips re-embed.
- **Notes:** `saveNote` writes note + `note.saved` event + embedding in one flow; inject a failing embedder → note kept, `indexed=false`, audit row still written; startup sweep then indexes it.
- **Search:** seed known chunks with stub vectors → query → assert similarity ordering + citations; assert dim-mismatch rows excluded; assert scope filter.
- **Events migration:** a note write produces an `events` row with `noteId` set and null `ticketId`; the CHECK rejects a row with neither.
- Reuse Phase 1 vitest + live Postgres on host port 5433.

## Acceptance

- Editing a vault file makes its new content retrievable via `search_knowledge` (through MCP) with a correct file-path citation; deleting the file removes it from results.
- `save_note` from one MCP session is retrievable via `search_knowledge` in a fresh session — proving cross-session memory sync — and shows an audited `note.saved` event attributed to the actor.
- Embedding-API failure during `save_note` does not lose the note.
- Full suite + typecheck green.

## Deferred to later slices
- GitHub (Octokit) and URL (readability+turndown) ingestion adapters behind the ingestion interface.
- PDF ingestion adapter via opendataloader-pdf (https://github.com/opendataloader-project/opendataloader-pdf) — extract structured text/tables from PDFs, then chunk+embed through the same pipeline as vault markdown. Same `sourceKind`-style adapter seam.
- Graph-knowledge layer via graphify (https://graphify.net/ , https://github.com/Graphify-Labs/graphify) — evaluate as a graph-based retrieval/relationship layer complementing pgvector semantic search (entities/relations extracted from ingested docs). Investigate fit + licensing before adopting; candidate for a hybrid graph+vector retrieval slice.
- Agent auto-capture memory policy.
- `related_to_ticket` auto-surfacing tool.
- Reranking / hybrid keyword+vector retrieval.
