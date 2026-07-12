# Native Knowledge Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notes become editable, listable, deletable documents (title + optimistic-versioned update + soft delete), audited and re-embedded, over REST and MCP — making VibeOps independent of Obsidian for authoring knowledge.

**Architecture:** Additive migration on `notes` (`title`, `version`, `deletedAt`); service functions mirroring the tickets guarded-UPDATE pattern (`src/services/tickets.ts:27-69` is the model); REST + MCP surface both routed through the same service (core invariant). Soft delete preserves the append-only `events` chain; a deleted note's embeddings are removed so search/getKnowledgeSource never serve it.

**Tech Stack:** drizzle-kit generate (migration), existing services/errors, Hono routes, MCP `registerTool`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-12-native-knowledge-workspace-design.md`.
- Migrations are additive-only. Generate with `npm run db:generate` after editing `src/db/schema.ts`; NEVER hand-edit `drizzle/meta`.
- Every mutation: transaction + audit event (`note.updated` / `note.deleted`), same transaction. Optimistic lock: guarded UPDATE with `version` in the WHERE (`StaleVersionError` on zero rows after an existence check that throws `NotFoundError` first). Soft-deleted notes behave as missing for every read path (`NotFoundError`), and never reach search.
- Embedding lifecycle on update: after the transaction commits, delete+reinsert the note's embeddings (`insertNoteEmbedding` already does delete+insert) and set `indexed=true`; on embed failure leave `indexed=false` (sweep re-embeds). Sweep (`sweepUnindexedNotes`) must skip soft-deleted notes.
- Stage ONLY files your task names (repo may carry unrelated user WIP). Never push. Suite needs Docker PG on :5433.

---

### Task 1: Migration + schema

**Files:**
- Modify: `src/db/schema.ts` (notes table)
- Generated: `drizzle/0003_*.sql` + `drizzle/meta/*` (via `npm run db:generate`)
- Test: existing `tests/embedded-db.test.ts` and `tests/schema.test.ts` must stay green (they run all migrations).

**Interfaces:**
- Produces: `notes` columns `title: text | null`, `version: integer not null default 1`, `deletedAt: timestamp | null` (drizzle fields `title`, `version`, `deletedAt`). Tasks 2-3 rely on these exact drizzle property names.

- [ ] **Step 1: Edit `src/db/schema.ts`** — in the `notes` table add after `body`:

```ts
  title: text("title"),
```

and after `indexed`:

```ts
  version: integer("version").notNull().default(1),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
```

(`integer` is already imported in this file; verify, add to the import if not.)

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate` — expect a new `drizzle/0003_*.sql` with three `ALTER TABLE "notes" ADD COLUMN` statements and updated meta. Inspect the SQL; nothing else may change.

- [ ] **Step 3: Apply to the test DB and run suite**

Run: `npm run db:push` (applies to the :5433 dev/test Postgres) then `npm test` — Expected: all green (embedded-db test proves the migration runs on PGlite too).

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat: note title, version, and soft-delete columns"
```

---

### Task 2: Service — update/delete/list/get + sweep filter + source guard

**Files:**
- Modify: `src/services/notes.ts`
- Modify: `src/services/knowledge.ts` (getKnowledgeSource note branch: exclude soft-deleted)
- Test: `tests/notes-workspace.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 columns; `insertNoteEmbedding` from `../services/knowledge.js` (already exported); `NotFoundError`, `StaleVersionError` from `./errors.js`; embeddings delete via drizzle (see deleteNote below).
- Produces (Task 3 imports these exact names from `../services/notes.js`):
  - `saveNote(actorId, { body, scope, refId?, title? }, embedder?)` (title added)
  - `updateNote(actorId: string, id: string, expectedVersion: number, patch: { title?: string; body?: string }, embedder?: Embedder): Promise<Note>`
  - `deleteNote(actorId: string, id: string, expectedVersion: number): Promise<void>`
  - `listNotes(filter?: { scope?: "global" | "project" | "ticket"; refId?: string; limit?: number }): Promise<Note[]>` (newest first, excludes deleted, default limit 50)
  - `getNote(id: string): Promise<Note>` (NotFoundError if missing or deleted)

- [ ] **Step 1: Write the failing tests**

Create `tests/notes-workspace.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createActor } from "../src/services/actors.js";
import { saveNote, updateNote, deleteNote, listNotes, getNote, sweepUnindexedNotes } from "../src/services/notes.js";
import { searchKnowledge, getKnowledgeSource } from "../src/services/knowledge.js";
import { FakeEmbedder } from "../src/knowledge/embedder.js";
import { StaleVersionError, NotFoundError } from "../src/services/errors.js";

const emb = new FakeEmbedder(1024);
const uniq = () => `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;

describe("notes workspace", () => {
  it("saves with a title, updates body with version bump, and re-embeds", async () => {
    const { actor } = await createActor({ name: uniq(), kind: "agent" });
    const oldBody = `original body ${uniq()}`;
    const note = await saveNote(actor.id, { body: oldBody, scope: "global", title: "Runbook" }, emb);
    expect(note.title).toBe("Runbook");
    expect(note.version).toBe(1);

    const newBody = `edited body ${uniq()}`;
    const updated = await updateNote(actor.id, note.id, 1, { body: newBody }, emb);
    expect(updated.version).toBe(2);
    expect(updated.body).toBe(newBody);

    const hits = await searchKnowledge(newBody, { limit: 5 }, emb);
    expect(hits.some((h) => h.sourceRef === note.id)).toBe(true);
    const oldHits = await searchKnowledge(oldBody, { limit: 5 }, emb);
    expect(oldHits.filter((h) => h.sourceRef === note.id && h.content === oldBody)).toHaveLength(0);
  });

  it("stale update and stale delete throw StaleVersionError", async () => {
    const { actor } = await createActor({ name: uniq(), kind: "agent" });
    const note = await saveNote(actor.id, { body: uniq(), scope: "global" }, emb);
    await expect(updateNote(actor.id, note.id, 99, { body: "x" }, emb)).rejects.toBeInstanceOf(StaleVersionError);
    await expect(deleteNote(actor.id, note.id, 99)).rejects.toBeInstanceOf(StaleVersionError);
  });

  it("soft delete hides the note from get/list/search/source and sweep", async () => {
    const { actor } = await createActor({ name: uniq(), kind: "agent" });
    const body = `deletable ${uniq()}`;
    const note = await saveNote(actor.id, { body, scope: "global" }, emb);
    await deleteNote(actor.id, note.id, 1);

    await expect(getNote(note.id)).rejects.toBeInstanceOf(NotFoundError);
    const listed = await listNotes({ scope: "global", limit: 200 });
    expect(listed.some((n) => n.id === note.id)).toBe(false);
    const hits = await searchKnowledge(body, { limit: 5 }, emb);
    expect(hits.some((h) => h.sourceRef === note.id)).toBe(false);
    expect(await getKnowledgeSource("note", note.id)).toMatch(/not found|deleted/i);
    expect(await sweepUnindexedNotes(emb)).toBeGreaterThanOrEqual(0); // must not resurrect embeddings
    const hitsAfter = await searchKnowledge(body, { limit: 5 }, emb);
    expect(hitsAfter.some((h) => h.sourceRef === note.id)).toBe(false);
  });

  it("update of a deleted or missing note is NotFound", async () => {
    const { actor } = await createActor({ name: uniq(), kind: "agent" });
    const note = await saveNote(actor.id, { body: uniq(), scope: "global" }, emb);
    await deleteNote(actor.id, note.id, 1);
    await expect(updateNote(actor.id, note.id, 2, { body: "x" }, emb)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateNote(actor.id, "00000000-0000-0000-0000-000000000000", 1, { body: "x" }, emb)).rejects.toBeInstanceOf(NotFoundError);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/notes-workspace.test.ts` — Expected: FAIL (missing exports).

- [ ] **Step 3: Implement in `src/services/notes.ts`**

Extend `saveNote`'s input type with `title?: string` and include `title: input.title` in the insert values. Then add (model: `src/services/tickets.ts:27-69`):

```ts
export async function updateNote(
  actorId: string,
  id: string,
  expectedVersion: number,
  patch: { title?: string; body?: string },
  embedder: Embedder = getEmbedder(),
): Promise<Note> {
  const note = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(notes).where(eq(notes.id, id)).limit(1);
    if (!current || current.deletedAt) throw new NotFoundError(`note ${id}`);
    if (current.version !== expectedVersion) throw new StaleVersionError(expectedVersion, current.version);

    const ALLOWED = ["title", "body"] as const;
    const clean = Object.fromEntries(
      Object.entries(patch).filter(([k, v]) => (ALLOWED as readonly string[]).includes(k) && v !== undefined),
    );
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, v] of Object.entries(clean)) {
      if ((current as Record<string, unknown>)[k] !== v) changes[k] = { from: (current as Record<string, unknown>)[k], to: v };
    }

    const [updated] = await tx.update(notes)
      .set({ ...clean, version: current.version + 1, indexed: false })
      .where(and(eq(notes.id, id), eq(notes.version, expectedVersion)))
      .returning();
    if (!updated) throw new StaleVersionError(expectedVersion, current.version);
    await tx.insert(events).values({ actorId, noteId: id, action: "note.updated", changes });
    return updated;
  });

  try {
    await insertNoteEmbedding(note.id, note.body, embedder);
    const [indexed] = await db.update(notes).set({ indexed: true }).where(eq(notes.id, note.id)).returning();
    return indexed;
  } catch {
    return note; // sweep re-embeds
  }
}

export async function deleteNote(actorId: string, id: string, expectedVersion: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(notes).where(eq(notes.id, id)).limit(1);
    if (!current || current.deletedAt) throw new NotFoundError(`note ${id}`);
    if (current.version !== expectedVersion) throw new StaleVersionError(expectedVersion, current.version);
    const [updated] = await tx.update(notes)
      .set({ deletedAt: new Date(), version: current.version + 1 })
      .where(and(eq(notes.id, id), eq(notes.version, expectedVersion)))
      .returning();
    if (!updated) throw new StaleVersionError(expectedVersion, current.version);
    await tx.insert(events).values({ actorId, noteId: id, action: "note.deleted" });
    // Deleted docs must leave the index (same transaction: no window where search serves a deleted note).
    await tx.delete(embeddings).where(and(eq(embeddings.sourceKind, "note"), eq(embeddings.sourceRef, id)));
  });
}

export async function listNotes(
  filter: { scope?: "global" | "project" | "ticket"; refId?: string; limit?: number } = {},
): Promise<Note[]> {
  const conds = [isNull(notes.deletedAt)];
  if (filter.scope) conds.push(eq(notes.scope, filter.scope));
  if (filter.refId) conds.push(eq(notes.refId, filter.refId));
  return db.select().from(notes).where(and(...conds))
    .orderBy(desc(notes.createdAt)).limit(filter.limit ?? 50);
}

export async function getNote(id: string): Promise<Note> {
  const [row] = await db.select().from(notes).where(and(eq(notes.id, id), isNull(notes.deletedAt))).limit(1);
  if (!row) throw new NotFoundError(`note ${id}`);
  return row;
}
```

Imports to add: `and, desc, isNull` from `drizzle-orm`; `embeddings` from `../db/schema.js`; `StaleVersionError` from `./errors.js`.

In `sweepUnindexedNotes`, change the pending query to exclude deleted:

```ts
const pending = await db.select().from(notes).where(and(eq(notes.indexed, false), isNull(notes.deletedAt)));
```

In `src/services/knowledge.ts` `getKnowledgeSource`, note branch: change the select to also filter `isNull(notes.deletedAt)` (import `isNull`), so a deleted note reads as not found.

- [ ] **Step 4: Run tests** — `npx vitest run tests/notes-workspace.test.ts` — Expected: PASS (4).

- [ ] **Step 5: Full suite + typecheck + commit**

```bash
npm test && npx tsc --noEmit
git add src/services/notes.ts src/services/knowledge.ts tests/notes-workspace.test.ts
git commit -m "feat: note update, soft delete, and listing with audited versioning"
```

---

### Task 3: REST + MCP surface

**Files:**
- Modify: `src/api/app.ts` (extend the notes block — NOTE: this file may carry unrelated user WIP; add your routes but stage the file ONLY if `git diff --cached` shows just your block after `git add -p`-free staging is impossible — read the controller note below)
- Modify: `src/mcp/server.ts` (three new tools + title on save_note)
- Test: `tests/notes-api.test.ts` (create)

**CONTROLLER NOTE (read first):** check `git status --short src/api/app.ts`. If it shows modified BEFORE you touch it, the file has user WIP: make your edits, run tests, but DO NOT commit app.ts — report that the controller must stage your hunk. If it is clean, commit normally.

**Interfaces:**
- Consumes: Task 2's service exports (exact signatures above); existing route conventions in app.ts (`c.get("actor").id`, error mapping via app.onError).
- Produces: REST `GET /notes`, `GET /notes/:id`, `PATCH /notes/:id`, `DELETE /notes/:id`; MCP tools `update_note`, `delete_note`, `list_notes`.

- [ ] **Step 1: Write the failing tests**

Create `tests/notes-api.test.ts` (model: existing REST tests use `app.request` or fetch against `app.fetch` — read one existing test, e.g. `tests/notes.test.ts` or `tests/api.test.ts`, and follow its auth-header/bootstrap convention exactly):

Test cases: POST /notes with title → 201 echoes title+version 1; PATCH with wrong expectedVersion → 409; PATCH with right version → 200 version 2; DELETE with right version → 200/204; GET /notes/:id after delete → 404; GET /notes?scope=global returns the earlier note before deletion (assert by id membership before/after).

- [ ] **Step 2: Run to verify failure** — Expected: 404s (routes missing).

- [ ] **Step 3: REST routes in `src/api/app.ts`**

Extend the notes block:

```ts
app.get("/notes", async (c) => c.json(await listNotes({
  scope: c.req.query("scope") as never, refId: c.req.query("refId"),
  limit: Number(c.req.query("limit")) || undefined,
})));
app.get("/notes/:id", async (c) => c.json(await getNote(c.req.param("id"))));
app.patch("/notes/:id", async (c) => {
  const { expectedVersion, title, body } = await c.req.json();
  return c.json(await updateNote(c.get("actor").id, c.req.param("id"), expectedVersion, { title, body }));
});
app.delete("/notes/:id", async (c) => {
  const { expectedVersion } = await c.req.json().catch(() => ({}));
  await deleteNote(c.get("actor").id, c.req.param("id"), Number(expectedVersion ?? c.req.query("expectedVersion")));
  return c.json({ ok: true });
});
```

`POST /notes` gains `title` passthrough. Update the import from `../services/notes.js`.

- [ ] **Step 4: MCP tools in `src/mcp/server.ts`**

```ts
server.registerTool("update_note",
  { inputSchema: { id: z.string(), expectedVersion: z.number(), title: z.string().optional(), body: z.string().optional() } },
  async ({ id, expectedVersion, ...patch }) => ({
    content: [{ type: "text", text: JSON.stringify(await updateNote(actor.id, id, expectedVersion, patch)) }],
  }));

server.registerTool("delete_note",
  { inputSchema: { id: z.string(), expectedVersion: z.number() } },
  async ({ id, expectedVersion }) => {
    await deleteNote(actor.id, id, expectedVersion);
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  });

server.registerTool("list_notes",
  { inputSchema: { scope: z.enum(["global", "project", "ticket"]).optional(), refId: z.string().optional(), limit: z.number().optional() } },
  async (f) => ({ content: [{ type: "text", text: JSON.stringify(await listNotes(f)) }] }));
```

`save_note`'s inputSchema gains `title: z.string().optional()` and passes it through. Update `tests/mcp-http.test.ts`'s expected tool list (it asserts the exact 7 — now 10: add `update_note`, `delete_note`, `list_notes`).

- [ ] **Step 5: Run new tests + mcp-http test** — Expected: PASS.

- [ ] **Step 6: Full suite + typecheck + commit (respect the controller note for app.ts)**

```bash
npm test && npx tsc --noEmit
git add src/mcp/server.ts tests/notes-api.test.ts   # + src/api/app.ts ONLY if it was clean pre-task
git commit -m "feat: note workspace over REST and MCP"
```

---

## Final steps (controller)

Stage the app.ts hunk if user WIP forced a split. Whole-branch review (sonnet; dimensions: soft-delete completeness — any read path that still serves deleted notes? version/audit correctness vs tickets pattern, MCP/REST parity). Fix wave, gates, ledger + memory. Then Phase 12 wires the UI.
