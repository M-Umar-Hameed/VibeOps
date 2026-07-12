# Native Knowledge Workspace / Source Independence (Design Spec)

## Context

The user's concern: VibeOps must survive Obsidian (the app) and claude-mem (a community plugin) going away. Findings from code review of the current state:

- **Obsidian-the-app is already not a runtime dependency.** The vault watcher reads plain markdown files from disk; the app is only the *editor*. If Obsidian dies, ingestion of existing files keeps working — what's lost is a way to author knowledge.
- **claude-mem is already optional.** Its reader returns `[]` with a warning when the DB is missing/unreadable, and Claude session coverage also comes from the direct Claude Code transcript reader (plus Codex/Antigravity from Phase 10). Nothing breaks without it.

The remaining true gap: VibeOps has no native way to author and maintain knowledge documents. `notes` are append-only memory blobs (no title, no update, no delete, no listing). This slice closes that gap by extending notes into a document workspace, answering the seeded ticket "Design native knowledge workspace versus Obsidian-first integration": **DB-native documents (extended notes), not a second file tree** — per the project's core principle, truth lives in Postgres, pgvector is a rebuildable projection; the Obsidian vault remains a read-only external source.

Decided autonomously (user: "make this a phase"), documented assumptions.

## Design

### Schema (migration 0003, additive)

`notes` gains: `title text` (nullable — untitled memory notes stay valid), `version integer not null default 1`, `deletedAt timestamptz` (nullable; soft delete preserves the append-only audit chain and the events FK).

### Service (`src/services/notes.ts` extensions)

- `updateNote(actorId, id, expectedVersion, patch: { title?, body? })` — same optimistic pattern as tickets: guarded UPDATE `where id = ... and version = expectedVersion and deleted_at is null`, zero rows → `StaleVersionError` (or `NotFoundError` if the note is missing/deleted); bumps `version`; writes `note.updated` audit event in the same transaction; after commit re-embeds (delete + insert embeddings for the note, `indexed` false→true semantics identical to save).
- `deleteNote(actorId, id, expectedVersion)` — guarded soft delete (`deletedAt = now()`), `note.deleted` audit event, removes the note's embeddings rows (deleted docs must leave the index).
- `listNotes({ scope?, refId?, limit?, includeDeleted? = false })` — newest first; `getNote(id)`.
- `saveNote` accepts optional `title`.
- The startup sweep and search must ignore soft-deleted notes (sweep filters `deletedAt is null`; embeddings rows for deleted notes are already gone).

### REST + MCP (parity per core invariant)

- REST: `GET /notes` (query: scope, refId, limit), `GET /notes/:id`, `PATCH /notes/:id` (body: expectedVersion, title?, body?) → 409 on stale, `DELETE /notes/:id` (body/query expectedVersion) → 409 on stale. `POST /notes` gains optional `title`.
- MCP: `update_note`, `delete_note`, `list_notes` tools mirroring the service; `save_note` gains optional `title`.
- `getKnowledgeSource("note", id)` must return an error for soft-deleted notes.

## Approaches considered

1. **Extend notes in the DB (chosen)** — reuses the audited service layer, the embed-after-commit resilience, the existing note sourceKind, and the backup story; one migration.
2. Files in `~/.vibeops/workspace` watched by the vault pipeline — Obsidian-compatible editing for free, but splits truth across DB + files, contradicts the truth-in-Postgres principle, and inherits watcher failure modes for first-party data.
3. New `documents` table — clean but duplicates 90% of notes (audit, scoping, embedding lifecycle) for a type distinction a nullable `title` already conveys. YAGNI.

## Error handling

Existing patterns throughout: NotFound/StaleVersion errors map to 404/409 in the REST layer; embedding failure on update leaves `indexed=false` for the sweep (never loses the edit); soft-deleted notes are invisible to list/get/search but preserved for audit.

## Testing

Service tests: update bumps version + re-embeds (search finds new body, not old); stale update/delete → StaleVersionError; delete removes embeddings + hides from list/get/getKnowledgeSource; sweep skips deleted; title round-trips. REST tests: PATCH/DELETE 409 paths + list filtering. MCP: tools registered (list assertion in existing mcp test).

## Out of scope

Editing UI (Phase 12 wires frontend), markdown rendering, folders/hierarchies, note-to-note links, hard delete/purge, export-to-vault.
