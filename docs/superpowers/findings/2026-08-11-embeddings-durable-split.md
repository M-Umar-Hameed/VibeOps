# Finding: Embeddings / Durable Data Split

Investigation for ticket: *Split embeddings out of the durable database so derived data cannot cost durable data*.

**Summary:** The join surface between embeddings and durable tables is wide. A split is feasible but requires app-side scoping rewrites and acceptance of eventual-consistency on four write paths.

---

## Q1: Imports of `src/db/client.ts` — how many touch embeddings?

22 files import from `src/db/client.ts`. **7 touch embeddings**; the other 15 are durable-only.

### Embeddings touchers (7)

| File | Lines | What it does |
|------|-------|--------------|
| `src/services/knowledge.ts` | all | All embeddings read/write + scope predicates |
| `src/services/notes.ts` | 98-99, 120 | Deletes embeddings inside note write; calls `insertNoteEmbedding` |
| `src/services/export.ts` | 62-65 | `buildBrief("project")` reads repo chunks from embeddings |
| `src/ingest/watch.ts` | 34-35, 77, 226-227 | contentHash read + vault counts |
| `src/ingest/sessions/ingest.ts` | 23-24 | contentHash read + `upsertSourceDoc` |
| `src/db/vector-setup.ts` | 10-11 | `CREATE EXTENSION vector`, `CREATE INDEX ... hnsw` |
| `src/services/projects.ts` | 279-280 | `deleteProject` calls `clearProjectKnowledge(tx)` |

### Durable-only importers (15)

`bootstrap.ts`, `sync/actor.ts`, `sync/push.ts`, `sync/import.ts`, `forge/verify.ts`, `forge/runs.ts`, `services/history.ts`, `services/reaper.ts`, `services/backup.ts`, `services/actors.ts`, `services/comments.ts`, `services/usage.ts`, `services/system.ts`, `services/settings.ts`, `services/tickets.ts`, `api/server.ts`.

---

## Q2: Is `src/runtime/slice.ts` template machinery reusable?

**No.**

`slice.ts` provisions per-run **external test Postgres** databases on `PG_BASE` (`:5433`, line 18) via SQL `CREATE DATABASE ... TEMPLATE` under advisory lock `918273` (lines 53-75). It never touches the embedded PGlite path.

The embedded split needs a second PGlite **directory + handle** in `src/db/client.ts:27-60` (different driver, `@electric-sql/pglite`, filesystem dir under `~/.vibeops/data`). Advisory-lock/template cloning solves suite-vs-suite contention on external PG, not derived-vs-durable fate isolation for embedded PGlite.

---

## Q3: Do `knowledgeGraph`/`searchKnowledge` join embeddings against nothing else?

**FALSE. The ticket's assumption is wrong. The join surface is WIDE.**

Both route through `projectScopeWhere` (`knowledge.ts:167-180`) and `globalScopeWhere` (`knowledge.ts:182-191`). These embed **SQL subqueries against `notes` and `tickets`** inside an embeddings query:

```sql
source_kind = 'note' AND source_ref IN (
  SELECT n.id::text FROM notes n
  LEFT JOIN tickets t ON t.id = n.ref_id
  WHERE n.deleted_at IS NULL AND ( ... n.ref_id = <projectId> OR t.project_id = <projectId> ) )
```

### Cross-table SQL callers (embeddings query references `notes`+`tickets` in one statement)

| Function | File:Lines | Description |
|----------|------------|-------------|
| `searchKnowledge` | `knowledge.ts:201-228` | When `projectId` set |
| `knowledgeGraph` | `knowledge.ts:365-372` | When `projectId` set |
| `clearProjectKnowledge` | `knowledge.ts:241-246` | `DELETE embeddings WHERE projectScopeWhere` subquery reads `notes`+`tickets` |

### Cross-table transactions (embeddings + durable mutated in one txn)

A second DB instance cannot span these atomically:

| Function | File:Lines | Description |
|----------|------------|-------------|
| `insertNoteEmbedding` | `knowledge.ts:78-90` | Reads `notes` then writes `embeddings` in one txn (stale-writer guard depends on it) |
| `updateNote` | `notes.ts:63-101` | Mutates `notes`+`events`+`embeddings` atomically |
| `deleteNote` | `notes.ts:108-122` | Mutates `notes`+`events`+`embeddings` atomically; comment at line 119 states "no window where search serves a deleted note" |
| `deleteProject` | `projects.ts:276-286` | `clearProjectKnowledge(tx)` subquery reads `notes`+`tickets` that the **same txn** deletes; comment at lines 276-277 states embeddings must be cleared WHILE notes+tickets still exist |

### Already split cleanly (no change needed)

`backup.ts:18` — `DURABLE` list explicitly excludes embeddings ("derived, rebuildable, ~99% of bytes").

---

## Boot-wedge nuance (ticket's second reason)

`autoSyncSessions` (`server.ts:65-84`) is fire-and-forget (`void`, line 84) with per-doc + per-source try/catch (`ingest.ts:20,28`). The wedge is **not** the ingest loop retrying — it is that embeddings and durable share **one PGlite instance (single WASM Postgres cluster)**: a corrupt embeddings/hnsw index corrupts the cluster, so ticket reads fail regardless of the loop.

Fate-sharing is at the storage-engine layer, `src/db/client.ts:27-60` (one `PGlite` client, one `db` handle). Isolation must be a **separate cluster/instance**, not just separate tables or schemas.

---

## Recommendation

**Second PGlite instance in its own directory** (ticket option 1) is the only shape that meets the goal ("derived data cannot cost durable data"): only a separate cluster gives independent corruption/recovery fate.

A separate **schema** in the same instance is rejected — same WASM cluster, same fate; it satisfies none of the ticket's premise while appearing to.

But the wide join surface makes this a **real migration, not a simple split**. A follow-up ticket must:

1. Move `projectScopeWhere`/`globalScopeWhere` note/ticket subqueries to **app-side**: query durable DB for the id set, pass as `inArray` into the embeddings DB (3 call sites: `searchKnowledge`, `knowledgeGraph`, `clearProjectKnowledge`).
2. Drop transactional atomicity on 4 write paths (`insertNoteEmbedding`, `updateNote`, `deleteNote`, `deleteProject`) and lean on the **already-existing** eventual-consistency machinery (`notes.indexed` flag + `sweepUnindexedNotes`, `notes.ts:40-54`). Note delete → embeddings delete becomes two-phase with an orphan sweep.
3. Second handle in `client.ts`; second migration dir; `ensureIndex`/`ensureExtension` run against both.

---

## Case against the recommendation

- Converts 3 index-assisted SQL predicates into two-round-trip app-side filters; larger id lists in `IN` clauses; a project with thousands of notes inflates the parameter list.
- Sacrifices atomicity on 4 durable-write paths. `deleteNote` currently guarantees no window where search serves a deleted note (`notes.ts:119`); cross-instance, that window opens and must be closed by a sweep — weaker guarantee than today.
- Doubles boot cost: two clusters open, two migration runs, two snapshot/backup targets.
- `slice.ts` gives no leverage (Q2), so the test harness for a two-instance embedded mode is net-new.
- Blast radius is 7 modules, but the 4 transactional paths are the durable-write hot paths — highest-risk code to touch.

---

## Open question for team

Before any follow-up build ticket: accept sweep-based eventual consistency on the 4 durable-write paths (enables true second-instance isolation), or accept same-cluster fate-sharing (separate schema, atomicity kept)?

The finding recommends the former; the answer scopes the next ticket.

---

## Resolution: DEFERRED (owner decision, 2026-08-12; ticket closed 2026-08-14)

The split was NOT built. The open question above is answered "neither, for now."

Every observed database failure — four incidents by 2026-08-14 — traced to
CONCURRENT OPEN of the data directory, never to embeddings corrupting durable
data. A second cluster does not defend against a second opener; it doubles what
a second opener can destroy. Meanwhile the cheaper protections landed and are
proven in practice: embeddings are excluded from logical exports, exports are
write-triggered and debounced (loss window minutes, not hours), the backup CLI
refuses a live data directory, and a restore has been executed twice for real.

### Revisit if ANY of these fires

1. The embedded database fails to open after a CLEAN shutdown. (Checked
   2026-08-12 and 2026-08-14: every failure followed a concurrent open or an
   unclean stop; a clean close has never failed to reopen.)
2. An embeddings index scan fails while the durable tables read and write
   normally — derived-data rot in isolation, exactly what the split prevents.
3. Embeddings growth makes snapshots/backups expensive. Measured 2026-08-14:
   logical exports ~4MB (embeddings excluded), known-good snapshot ~166MB
   against a 382MB live dir. Re-check when the live dir passes ~1GB.

This section replaces board ticket add0ef49, closed so the board only carries
actionable work. This doc is indexed into knowledge search, so any future
incident investigation that touches embeddings or the embedded cluster will
surface it.
