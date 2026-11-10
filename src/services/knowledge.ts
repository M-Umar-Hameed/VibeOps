import { createHash } from "node:crypto";
import { statSync, readdirSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { resolveProjectVaultPath } from "../ingest/vault-path.js";
import { and, eq, isNull, inArray, like, notInArray, sql as dsql } from "drizzle-orm";
import { db } from "../db/client.js";
import { embeddings, notes, projects, tickets } from "../db/schema.js";
import { ConflictError, NotFoundError } from "./errors.js";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
import { chunkMarkdown } from "../knowledge/chunker.js";
import { getEmbedder, type Embedder } from "../knowledge/embedder.js";
import type { JobCtx } from "./jobs.js";
import { redactSecrets } from "../forge/redact.js";
import { logKnowledgeQuery } from "./usage.js";
import { bump } from "../services/metrics.js";
import { noteIndexText } from "./note-index-text.js";

// vault sourceRef is either a legacy absolute path (global vault) or
// "<projectId>:<relPosix>" for a project vault; map the latter back to disk.
async function resolveVaultRefPath(ref: string): Promise<string> {
  const m = /^([0-9a-fA-F-]{36}):(.+)$/.exec(ref);
  if (!m) return ref;
  return join(await resolveProjectVaultPath(m[1]), m[2]);
}

// project_id for a source_ref: repo/vault/chat carry a "<uuid>:" prefix -> that
// uuid; session and legacy-bare (global) refs -> null. Mirrors resolveVaultRefPath's
// prefix regex so the scope column and vault-path resolution agree on "a prefix".
function refProjectId(ref: string): string | null {
  const m = /^([0-9a-fA-F-]{36}):/.exec(ref);
  return m ? m[1] : null;
}

// A note's project: scope 'project' -> refId is the project; scope 'ticket' -> the
// ticket's project; anything else is global. Mirrors drizzle/0019's backfill CASE.
async function noteScopeProjectId(noteId: string): Promise<string | null> {
  // notes.id is a uuid column; a non-uuid ref (synthetic test refs, legacy rows)
  // would make Postgres throw on the cast rather than simply not match.
  if (!/^[0-9a-fA-F-]{36}$/.test(noteId)) return null;
  const [n] = await db.select({ scope: notes.scope, refId: notes.refId })
    .from(notes).where(eq(notes.id, noteId)).limit(1);
  if (!n || !n.refId) return null;
  if (n.scope === "project") return n.refId;
  if (n.scope === "ticket") {
    const [t] = await db.select({ projectId: tickets.projectId })
      .from(tickets).where(eq(tickets.id, n.refId)).limit(1);
    return t?.projectId ?? null;
  }
  return null;
}

// One-time backfill of embeddings.project_id from the legacy source_ref convention.
// Re-runnable: the `project_id IS NULL` guards make a second run a no-op. Exported so
// tests can seed legacy (null-projectId) rows and assert idempotency; the migration
// runs the identical statements against production data.
export async function backfillEmbeddingProjectIds(exec: Executor = db): Promise<void> {
  await exec.execute(dsql`
    UPDATE "embeddings"
    SET "project_id" = substring("source_ref" from 1 for 36)::uuid
    WHERE "source_kind" IN ('repo','vault','chat')
      AND "source_ref" ~ '^[0-9a-fA-F-]{36}:'
      AND "project_id" IS NULL`);
  await exec.execute(dsql`
    UPDATE "embeddings" e
    SET "project_id" = sub.pid
    FROM (
      SELECT n.id::text AS ref,
             CASE WHEN n.scope = 'project' THEN n.ref_id
                  WHEN n.scope = 'ticket'  THEN t.project_id
                  ELSE NULL END AS pid
      FROM notes n
      LEFT JOIN tickets t ON t.id = n.ref_id
      WHERE n.deleted_at IS NULL
    ) sub
    WHERE e.source_kind = 'note' AND e.source_ref = sub.ref
      AND e.project_id IS NULL`);
}

export function fileHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function fileHashBytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function vecLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

export async function prepareSourceDoc(
  kind: "vault" | "note" | "session" | "repo" | "chat",
  ref: string,
  text: string,
  contentHash?: string,
  projectId?: string | null,
): Promise<{
  kind: string;
  ref: string;
  hash: string;
  scopeId: string | null;
  newChunks: { index: number; content: string }[];
  reuseIds: string[];
  deadIds: string[];
}> {
  const chunks = chunkMarkdown(text);
  const hash = contentHash ?? fileHash(text);
  // Incremental diff: reuse a stored row when an incoming chunk at the SAME index has
  // identical redacted content — only new/changed chunks are embedded. Chat re-ingests
  // the whole transcript every turn; append-mostly transcripts drop from O(n^2) to
  // O(new). Key on content equality (not a hash): both strings are already in memory,
  // so equality is exact and cheaper than sha256.
  // ponytail: match is position+content, so a prepend/reorder re-embeds the shifted
  // tail; append and in-place edits (the common paths) reuse. Add an LCS diff only if
  // reorder-heavy docs ever dominate.
  const existing = await db.select({ id: embeddings.id, chunkIndex: embeddings.chunkIndex, content: embeddings.content })
    .from(embeddings)
    .where(and(eq(embeddings.sourceKind, kind), eq(embeddings.sourceRef, ref)));
  const existingByIndex = new Map(existing.map((r) => [r.chunkIndex, r]));

  const incoming = chunks.map((c) => ({ index: c.index, content: redactSecrets(c.content) }));
  const reuseIds: string[] = [];
  const reusedIndexes = new Set<number>();
  const newChunks: { index: number; content: string }[] = [];
  for (const c of incoming) {
    const prev = existingByIndex.get(c.index);
    if (prev && prev.content === c.content) { reuseIds.push(prev.id); reusedIndexes.add(c.index); }
    else newChunks.push(c);
  }
  const deadIds = existing.filter((r) => !reusedIndexes.has(r.chunkIndex)).map((r) => r.id);

  // S5 moved scope from query-time (the old predicate resolved notes via a subquery
  // on every read, so it was right no matter who wrote the row) to WRITE time, which
  // is only right if every writer sets it. A note ref carries no "<uuid>:" prefix, so
  // resolve it from the notes table exactly as the backfill migration does; otherwise a
  // note indexed through this generic path lands unscoped and survives clearProjectKnowledge.
  const scopeId = projectId !== undefined ? projectId : (kind === "note" ? await noteScopeProjectId(ref) : refProjectId(ref));

  return { kind, ref, hash, scopeId, newChunks, reuseIds, deadIds };
}

export async function writeSourceDoc(
  prep: {
    kind: string;
    ref: string;
    hash: string;
    scopeId: string | null;
    newChunks: { index: number; content: string }[];
    reuseIds: string[];
    deadIds: string[];
  },
  vecs: number[][],
  embedder: Embedder,
): Promise<number> {
  const rows = prep.newChunks.map((c, i) => ({
    sourceKind: prep.kind as "vault" | "note" | "session" | "repo" | "chat",
    sourceRef: prep.ref,
    chunkIndex: c.index,
    content: c.content,
    embedding: vecs[i],
    model: embedder.model,
    dim: embedder.dim,
    contentHash: prep.hash,
    projectId: prep.scopeId,
  }));
  // One transaction so a mid-batch failure rolls everything back. Delete dead rows
  // first, then insert new ones (freed indices reuse safely); rewrite reused rows'
  // contentHash to the current doc hash so every row for the ref shares one hash —
  // reindexFile's limit(1) gate and the one-distinct-hash invariant depend on it.
  // Batched inserts: a multi-thousand-row statement overflows PGlite's WASM memory.
  await db.transaction(async (tx) => {
    if (prep.deadIds.length) await tx.delete(embeddings).where(inArray(embeddings.id, prep.deadIds));
    if (prep.reuseIds.length) await tx.update(embeddings).set({ contentHash: prep.hash, projectId: prep.scopeId }).where(inArray(embeddings.id, prep.reuseIds));
    for (let i = 0; i < rows.length; i += 100) {
      await tx.insert(embeddings).values(rows.slice(i, i + 100));
    }
  });
  bump("embed.chunks", vecs.length);
  return vecs.length;
}

export async function upsertSourceDoc(
  kind: "vault" | "note" | "session" | "repo" | "chat",
  ref: string,
  text: string,
  embedder: Embedder,
  contentHash?: string,
  projectId?: string | null,
): Promise<number> {
  const prep = await prepareSourceDoc(kind, ref, text, contentHash, projectId);
  const vecs = prep.newChunks.length ? await embedder.embed(prep.newChunks.map((c) => c.content)) : [];
  return writeSourceDoc(prep, vecs, embedder);
}

// Append-only write for growing transcripts: new chunks continue after the ref's max chunkIndex;
// existing rows for the ref are never updated or deleted.
export async function appendSourceDoc(
  kind: "vault" | "note" | "session" | "repo" | "chat",
  ref: string,
  text: string,
  embedder: Embedder,
  contentHash?: string,
  projectId?: string | null,
): Promise<number> {
  const contents = chunkMarkdown(text).map((c) => redactSecrets(c.content)).filter((c) => c.trim());
  if (!contents.length) return 0;
  const [{ max }] = await db.select({ max: dsql<number | null>`max(${embeddings.chunkIndex})` })
    .from(embeddings)
    .where(and(eq(embeddings.sourceKind, kind), eq(embeddings.sourceRef, ref)));
  const base = max === null || max === undefined ? 0 : Number(max) + 1;
  const vecs = await embedder.embed(contents);
  const hash = contentHash ?? fileHash(text);
  const scopeId = projectId !== undefined ? projectId : refProjectId(ref);
  const rows = contents.map((content, i) => ({
    sourceKind: kind, sourceRef: ref, chunkIndex: base + i, content, embedding: vecs[i],
    model: embedder.model, dim: embedder.dim, contentHash: hash, projectId: scopeId,
  }));
  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += 100) await tx.insert(embeddings).values(rows.slice(i, i + 100));
  });
  bump("embed.chunks", vecs.length);
  return vecs.length;
}

export const EMBED_BATCH = 32;

export async function upsertSourceDocsBatched(
  kind: "vault" | "note" | "session" | "repo" | "chat",
  docs: { ref: string; text: string; contentHash?: string; projectId?: string | null }[],
  embedder: Embedder,
  batch = EMBED_BATCH,
  hooks: { onDoc?: (done: number) => void; isCancelled?: () => boolean } = {},
): Promise<{ ref: string; ok: boolean; error?: string }[]> {
  const results: { ref: string; ok: boolean; error?: string }[] = [];
  const pending: { prep: Awaited<ReturnType<typeof prepareSourceDoc>>; docIndex: number }[] = [];
  let pendingChunks = 0;
  let settled = 0;
  const settle = (i: number, r: { ref: string; ok: boolean; error?: string }) => {
    results[i] = r;
    hooks.onDoc?.(++settled);
  };

  const flush = async () => {
    if (pending.length === 0) return;
    const allChunks = pending.flatMap((p) => p.prep.newChunks.map((c) => c.content));
    try {
      const allVecs = await embedder.embed(allChunks);
      let offset = 0;
      for (const { prep, docIndex } of pending) {
        const vecs = allVecs.slice(offset, offset + prep.newChunks.length);
        offset += prep.newChunks.length;
        try {
          await writeSourceDoc(prep, vecs, embedder);
          settle(docIndex, { ref: prep.ref, ok: true });
        } catch (e) {
          settle(docIndex, { ref: prep.ref, ok: false, error: (e as Error).message });
        }
      }
    } catch (e) {
      // Batch embed failed, fall back to one-by-one
      for (const { prep, docIndex } of pending) {
        try {
          const vecs = prep.newChunks.length ? await embedder.embed(prep.newChunks.map((c) => c.content)) : [];
          await writeSourceDoc(prep, vecs, embedder);
          settle(docIndex, { ref: prep.ref, ok: true });
        } catch (err) {
          settle(docIndex, { ref: prep.ref, ok: false, error: (err as Error).message });
        }
      }
    }
    pending.length = 0;
    pendingChunks = 0;
  };

  for (let i = 0; i < docs.length; i++) {
    if (hooks.isCancelled?.()) break;
    const doc = docs[i];
    try {
      const prep = await prepareSourceDoc(kind, doc.ref, doc.text, doc.contentHash, doc.projectId);
      if (prep.newChunks.length === 0) {
        // No new chunks, just write metadata update
        await writeSourceDoc(prep, [], embedder);
        settle(i, { ref: doc.ref, ok: true });
      } else {
        pending.push({ prep, docIndex: i });
        pendingChunks += prep.newChunks.length;
        if (pendingChunks >= batch) {
          await flush();
        }
      }
    } catch (e) {
      settle(i, { ref: doc.ref, ok: false, error: (e as Error).message });
    }
  }

  await flush();
  return results.filter(Boolean);
}

export async function upsertVaultFile(path: string, text: string, embedder: Embedder, contentHash?: string): Promise<number> {
  return upsertSourceDoc("vault", path, text, embedder, contentHash);
}

export async function deleteVaultFile(path: string): Promise<void> {
  await db.delete(embeddings)
    .where(and(eq(embeddings.sourceKind, "vault"), eq(embeddings.sourceRef, path)));
}

export async function deleteChatDoc(ref: string): Promise<void> {
  await db.delete(embeddings)
    .where(and(eq(embeddings.sourceKind, "chat"), eq(embeddings.sourceRef, ref)));
}

export async function insertNoteEmbedding(noteId: string, body: string, embedder: Embedder): Promise<boolean> {
  const chunks = chunkMarkdown(body);
  const hash = fileHash(body);
  const parts = chunks.length ? chunks : [{ index: 0, content: body }];
  const vecs = await embedder.embed(parts.map((c) => c.content));
  // All writers (save, update, sweep) route through here with a body they read
  // earlier. Verify it is STILL the note's body inside the write transaction —
  // otherwise a slow sweep clobbers a fresh re-embed with a stale snapshot.
  return db.transaction(async (tx) => {
    const [current] = await tx.select({
      body: notes.body, kind: notes.kind, rationale: notes.rationale,
      deletedAt: notes.deletedAt, scope: notes.scope, refId: notes.refId,
    }).from(notes).where(eq(notes.id, noteId)).limit(1);
    // Compare against noteIndexText's output (decisions embed body+rationale),
    // not the raw body column, so a stale writer is detected correctly.
    const currentIndexText = current ? noteIndexText(current) : undefined;
    if (!current || current.deletedAt || currentIndexText !== body) return false; // stale writer: no-op
    await tx.delete(embeddings)
      .where(and(eq(embeddings.sourceKind, "note"), eq(embeddings.sourceRef, noteId)));
    let noteProjectId: string | null = null;
    if (current.scope === "project") noteProjectId = current.refId ?? null;
    else if (current.scope === "ticket" && current.refId) {
      const [tk] = await tx.select({ projectId: tickets.projectId })
        .from(tickets).where(eq(tickets.id, current.refId)).limit(1);
      noteProjectId = tk?.projectId ?? null;
    }
    await tx.insert(embeddings).values(parts.map((c, i) => ({
      sourceKind: "note" as const, sourceRef: noteId, chunkIndex: c.index,
      content: redactSecrets(c.content), embedding: vecs[i], model: embedder.model, dim: embedder.dim,
      contentHash: hash, projectId: noteProjectId,
    })));
    return true;
  });
}

function walkRepoDocs(root: string, currentDir = root, depth = 0, files: string[] = []): string[] {
  if (depth > 4) return files;
  try {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const name = entry.name;
      if (entry.isDirectory()) {
        if (name === "node_modules" || name === ".git" || name === "coverage" || name === "build" || /^dist/.test(name)) continue;
        walkRepoDocs(root, join(currentDir, name), depth + 1, files);
      } else {
        if (/\.md$/i.test(name) || /^readme/i.test(name) || name === "CLAUDE.md" || name === "AGENTS.md") {
          files.push(join(currentDir, name));
        }
      }
    }
  } catch (e) {
    // skip unreadable
  }
  return files;
}

export async function indexRepoDocs(
  projectId: string,
  ctx?: JobCtx,
): Promise<{ indexed: number; skipped: number; removed: number; cancelled?: boolean }> {
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!p) throw new NotFoundError(`project not found: ${projectId}`);
  if (!p.repoPath) throw new ConflictError("project has no repoPath set");
  const root = p.repoPath;
  const embedder = getEmbedder();
  const files = walkRepoDocs(root);
  ctx?.progress({ phase: "reading docs", done: 0, total: files.length });
  let skipped = 0;
  const items: { ref: string; text: string }[] = [];

  for (let i = 0; i < files.length; i++) {
    if (ctx?.cancelled) break;
    const file = files[i];
    try {
      const stat = statSync(file);
      if (stat.size > 200 * 1024) {
        skipped++;
        continue;
      }
      const text = await readFile(file, "utf-8");
      const relPosix = relative(root, file).split(sep).join("/");
      const ref = `${projectId}:${relPosix}`;
      items.push({ ref, text });
    } catch (e) {
      // skip unreadable file
    } finally {
      ctx?.progress({ done: i + 1 });
    }
  }

  ctx?.progress({ phase: "embedding docs", done: 0, total: items.length });
  const results = await upsertSourceDocsBatched("repo", items, embedder, EMBED_BATCH, {
    onDoc: (n) => ctx?.progress({ done: n }),
    isCancelled: () => !!ctx?.cancelled,
  });
  const indexed = results.filter((r) => r.ok).length;
  const kept = results.filter((r) => r.ok).map((r) => r.ref);

  if (ctx?.cancelled) {
    // A partial kept list would delete docs that were never processed.
    return { indexed, skipped, removed: 0, cancelled: true };
  }

  ctx?.progress({ phase: "removing stale docs" });
  const removedRows = await db.delete(embeddings)
    .where(and(
      eq(embeddings.sourceKind, "repo"),
      like(embeddings.sourceRef, `${projectId}:%`),
      kept.length ? notInArray(embeddings.sourceRef, kept) : undefined
    ))
    .returning({ ref: embeddings.sourceRef });
  const removed = new Set(removedRows.map(r => r.ref)).size;
  // upsertSourceDoc diffs per chunk, so re-indexing only embeds changed/new chunks;
  // unchanged repo docs cost one content compare (no embeds). No per-file gate needed.
  return { indexed, skipped, removed };
}

export async function repoIndexed(projectId: string): Promise<boolean> {
  const [row] = await db.select({ id: embeddings.id }).from(embeddings)
    .where(and(eq(embeddings.sourceKind, "repo"), like(embeddings.sourceRef, `${projectId}:%`)))
    .limit(1);
  return !!row;
}

// Column-indexed scope (S5). project_id = P is project-only, so clearProjectKnowledge
// deletes exactly this project's rows and knowledgeGraph keeps project/global disjoint.
// searchKnowledge ORs this with globalScopeWhere so global rows stay visible in a
// scoped search — that union lives in the caller, NOT here (see :235).
export function projectScopeWhere(projectId: string) {
  return dsql`(project_id = ${projectId}::uuid)`;
}

function globalScopeWhere() {
  return dsql`(project_id IS NULL)`;
}

export async function searchKnowledge(
  query: string,
  opts: { limit?: number; projectId?: string; caller?: string } = {},
  embedder: Embedder = getEmbedder(),
): Promise<{ content: string; sourceKind: string; sourceRef: string; score: number; citation: string; createdAt: string }[]> {
  const [qv] = await embedder.embed([query]);
  const limit = opts.limit ?? 5;
  const lit = vecLiteral(qv);
  const scope = opts.projectId
    ? dsql`AND (${projectScopeWhere(opts.projectId)} OR ${globalScopeWhere()})`
    : dsql``;
  // Cosine distance; filter to active dim so mixed-dim rows never compare.
  // SET LOCAL needs the same connection as the query, hence the transaction.
  // ef_search 100 (default 40): the dim filter runs AFTER the ANN scan, so
  // mixed-dim/mixed-source indexes need a wider candidate pool or exact
  // matches fall out of the top-k as the table grows.
  // Inner query does the ANN scan (cheap, index-assisted) over a wider
  // candidate pool; outer query re-ranks that pool by recency-decayed score
  // so the HNSW index is never asked to order by anything but distance.
  const res: unknown = await db.transaction(async (tx) => {
    await tx.execute(dsql`set local hnsw.ef_search = 200`);
    return tx.execute(dsql`
    select source_kind, source_ref, content, created_at,
           (1 - cosine_distance) * (1.0 / (1.0 + extract(epoch from (now() - created_at)) / (86400.0 * 90))) as score
    from (
      select source_kind, source_ref, content, created_at,
             embedding <=> ${lit}::vector as cosine_distance
      from embeddings
      where dim = ${embedder.dim}
      ${scope}
      order by embedding <=> ${lit}::vector
      limit ${limit * 4}
    ) candidates
    order by score desc
    limit ${limit}`);
  });
  const rows = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as any[];
  const out = rows.map((r: any) => ({
    content: r.content, sourceKind: r.source_kind, sourceRef: r.source_ref,
    score: Number(r.score), citation: r.source_ref,
    createdAt: new Date(r.created_at).toISOString(),
  }));
  await logKnowledgeQuery({
    caller: opts.caller ?? "unknown",
    projectId: opts.projectId,
    hitKinds: out.map((h) => h.sourceKind),
    topScore: out[0]?.score,
    queryText: query,
  });
  return out;
}

// Removes exactly the project's indexed chunks — repo docs, project-vault files,
// project-mapped sessions, and project/ticket note chunks — as defined by the shared
// scoping predicate. Leaves global sources (legacy shared vault, unmatched sessions)
// and every notes row itself. Takes an executor so deleteProject can call it inside its transaction.
export async function clearProjectKnowledge(projectId: string, executor: Executor = db): Promise<number> {
  const rows = await executor.delete(embeddings)
    .where(projectScopeWhere(projectId))
    .returning({ id: embeddings.id });
  return rows.length;
}

export async function listSessionDocs(limit = 50): Promise<{ ref: string; chunkCount: number; created_at: string; excerpt: string }[]> {
  const rows: unknown = await db.execute(dsql`
    SELECT source_ref, count(id) as chunk_count, max(created_at) as created_at
    FROM embeddings
    WHERE source_kind = 'session'
    GROUP BY source_ref
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);
  
  const aggRows = (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows) as any[];
  if (!aggRows.length) return [];
  
  const refs = aggRows.map(r => String(r.source_ref));
  const chunkRows = await db.select({ sourceRef: embeddings.sourceRef, content: embeddings.content })
    .from(embeddings)
    .where(and(eq(embeddings.sourceKind, "session"), eq(embeddings.chunkIndex, 0), inArray(embeddings.sourceRef, refs)));
    
  const chunkMap = new Map(chunkRows.map(c => [c.sourceRef, c.content]));
  
  return aggRows.map(r => ({
    ref: r.source_ref,
    chunkCount: Number(r.chunk_count),
    created_at: new Date(r.created_at).toISOString(),
    excerpt: (chunkMap.get(r.source_ref) || "").slice(0, 200)
  }));
}

// Indexed chunks reassembled in order; null when the ref is not indexed.
async function indexedText(kind: "session" | "chat" | "repo", ref: string): Promise<string | null> {
  const rows = await db.select({ content: embeddings.content })
    .from(embeddings)
    .where(and(eq(embeddings.sourceKind, kind), eq(embeddings.sourceRef, ref)))
    .orderBy(embeddings.chunkIndex);
  return rows.length ? rows.map((r) => r.content).join("\n\n") : null;
}

export async function getKnowledgeSource(kind: string, ref: string): Promise<string> {
  if (kind === "vault") {
    // Only serve refs that exist in the knowledge index (exact sourceRef match).
    // Without this check the endpoint is an arbitrary file read for any actor.
    const [indexed] = await db.select({ id: embeddings.id }).from(embeddings)
      .where(and(eq(embeddings.sourceKind, "vault"), eq(embeddings.sourceRef, ref))).limit(1);
    if (!indexed) return `Error: ${ref} is not an indexed vault source.`;
    try {
      return await readFile(await resolveVaultRefPath(ref), "utf-8");
    } catch (e) {
      return `Error: Could not read vault file ${ref}.`;
    }
  } else if (kind === "note") {
    try {
      const [noteRow] = await db.select({ body: notes.body }).from(notes).where(and(eq(notes.id, ref), isNull(notes.deletedAt))).limit(1);
      return noteRow ? noteRow.body : `Error: Note ${ref} not found.`;
    } catch (e: any) {
      return `Error: DB query failed: ${e.message}`;
    }
  } else if (kind === "session") {
    return (await indexedText("session", ref)) ?? `Error: Session ${ref} not found in the index.`;
  } else if (kind === "chat") {
    return (await indexedText("chat", ref)) ?? `Error: Chat ${ref} not found in the index.`;
  } else if (kind === "repo") {
    // Same exact-sourceRef gate as vault: never an arbitrary file read.
    const chunks = await indexedText("repo", ref);
    if (chunks === null) return `Error: ${ref} is not an indexed repo source.`;
    const m = /^([0-9a-fA-F-]{36}):(.+)$/.exec(ref);
    if (!m) return `Error: ${ref} is not a valid repo source ref.`;
    const [p] = await db.select({ repoPath: projects.repoPath }).from(projects).where(eq(projects.id, m[1])).limit(1);
    if (!p?.repoPath) return chunks; // repo moved/unset: indexed text is still the source
    const inside = (root: string, file: string) => {
      const rel = relative(root, file);
      return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    };
    const file = join(p.repoPath, m[2]);
    if (!inside(p.repoPath, file)) return `Error: ${ref} resolves outside the project repo.`;
    let realFile: string;
    try {
      realFile = await realpath(file);
    } catch {
      return chunks; // file gone: fall back to indexed chunks
    }
    let realRoot: string;
    try { realRoot = await realpath(p.repoPath); } catch { return chunks; }
    // Symlinks/junctions: compare canonical paths (repoPath itself may be a junction).
    if (!inside(realRoot, realFile)) return `Error: ${ref} resolves outside the project repo.`;
    try {
      return await readFile(realFile, "utf-8");
    } catch {
      return chunks;
    }
  }
  return `Error: Unknown source kind ${kind}`;
}

// Round-robin fair-share: each kind present in `rows` drafts its newest unused
// row in turn until the budget fills; unused capacity spills to kinds with more
// rows. Rows must arrive grouped per kind, newest-first within each kind.
// Guarantees every present kind appears when limit >= number of kinds.
function budgetByKind(rows: any[], limit: number): any[] {
  const byKind = new Map<string, any[]>();
  for (const r of rows) {
    const k = String(r.source_kind);
    let arr = byKind.get(k);
    if (!arr) { arr = []; byKind.set(k, arr); }
    arr.push(r);
  }
  const kinds = [...byKind.keys()];
  const cursor = new Map(kinds.map((k) => [k, 0]));
  const out: any[] = [];
  let progress = true;
  while (out.length < limit && progress) {
    progress = false;
    for (const k of kinds) {
      if (out.length >= limit) break;
      const arr = byKind.get(k)!;
      const i = cursor.get(k)!;
      if (i < arr.length) {
        out.push(arr[i]);
        cursor.set(k, i + 1);
        progress = true;
      }
    }
  }
  return out;
}

export const GRAPH_MAX_LIMIT = 1000;

// ponytail: edge building is O(n^2) in JS, ~500k cosine pairs at the 1000 cap.
export function clampGraphLimit(raw: unknown, fallback = 60): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? Math.min(n, GRAPH_MAX_LIMIT) : fallback;
}

export async function knowledgeGraph(limit = 60, projectId?: string, refs?: string[]): Promise<{ nodes: { id: string; kind: string; chunks: number; createdAt: string }[]; edges: { a: string; b: string; w: number }[] }> {
  limit = clampGraphLimit(limit);
  // repo nodes carry a "<projectId>:" sourceRef prefix. Sessions with a project_id
  // are project rows; sessions with no project_id (unmatched sessions) are global.
  // note nodes map to a project via scope+refId; global-scope notes are global.
  // vault is always global.
  const unwrap = (r: unknown) => (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as any[];
  const perKindQuery = (where: ReturnType<typeof dsql>) => db.execute(dsql`
    SELECT source_ref, source_kind, chunk_count, created_at FROM (
      SELECT source_ref, source_kind, count(id) AS chunk_count, max(created_at) AS created_at,
        row_number() OVER (PARTITION BY source_kind ORDER BY max(created_at) DESC) AS rn
      FROM embeddings
      ${where}
      GROUP BY source_ref, source_kind
    ) sub
    WHERE rn <= ${limit}
    ORDER BY source_kind ASC, rn ASC
  `);

  // Test-only scoping: restrict candidates to caller-supplied refs so a test can
  // assert against exactly its own seeded rows without truncating the shared table.
  const refWhere = refs && refs.length ? inArray(embeddings.sourceRef, refs) : null;
  let rows: any[];
  if (projectId) {
    // Budget the node list so a project's own nodes are never crowded out by the
    // globally-shared, always-newer session/vault stream. Project-scoped nodes
    // (repo docs + this project's sessions + this project's project/ticket notes)
    // are selected FIRST, then remaining slots fill with global nodes (vault +
    // unmatched sessions + global-scope notes), newest-first within each group.
    // The two groups are disjoint (a row is repo, vault, session, or a note of
    // exactly one scope) so no dedup is needed.
    const projectWhere = refWhere
      ? dsql`WHERE ${projectScopeWhere(projectId)} AND ${refWhere}`
      : dsql`WHERE ${projectScopeWhere(projectId)}`;
    const globalWhere = refWhere
      ? dsql`WHERE ${globalScopeWhere()} AND ${refWhere}`
      : dsql`WHERE ${globalScopeWhere()}`;
    // Fair-share by kind within each group (round-robin) so repo docs and
    // project-vault files always appear next to notes even when notes are newer.
    const projectRows = budgetByKind(unwrap(await perKindQuery(projectWhere)), limit);
    const globalRows = budgetByKind(unwrap(await perKindQuery(globalWhere)), limit);
    // Reserve a floor for global (shared vault/session) nodes so shared knowledge
    // stays visible even when a project has more than `limit` nodes; project-first
    // for the remaining budget, newest-first within each group.
    const GLOBAL_FLOOR = Math.floor(limit * 0.25);
    const reservedGlobal = globalRows.slice(0, GLOBAL_FLOOR);
    const projectTake = projectRows.slice(0, limit - reservedGlobal.length);
    const extraGlobal = globalRows.slice(reservedGlobal.length, limit - projectTake.length);
    rows = [...projectTake, ...reservedGlobal, ...extraGlobal].slice(0, limit);
  } else {
    // Fair-share the budget across kinds so the high-volume, always-newest
    // session stream can't starve vault/note/repo (which plain newest-first-
    // across-all-kinds would drop entirely). Fetch top-`limit` per kind, then
    // round-robin. Total node count still bounded by `limit`.
    rows = budgetByKind(unwrap(await perKindQuery(refWhere ? dsql`WHERE ${refWhere}` : dsql``)), limit);
  }
  if (!rows.length) return { nodes: [], edges: [] };

  const rowRefs = rows.map(r => String(r.source_ref));
  const chunkRows = await db.select({ sourceRef: embeddings.sourceRef, embedding: dsql<string>`${embeddings.embedding}::text` })
    .from(embeddings)
    .where(and(eq(embeddings.chunkIndex, 0), inArray(embeddings.sourceRef, rowRefs)));

  const embMap = new Map(chunkRows.map(c => {
    let arr: number[] = [];
    try {
      arr = JSON.parse(c.embedding);
    } catch (e) {
      // In case the pgvector format is [1,2,3] string instead of array
      const s = c.embedding.trim();
      if (s.startsWith('[') && s.endsWith(']')) {
        arr = s.slice(1, -1).split(',').map(Number);
      }
    }
    return [c.sourceRef, arr];
  }));

  const nodes = rows.map(r => ({
    id: String(r.source_ref),
    kind: String(r.source_kind),
    chunks: Number(r.chunk_count),
    createdAt: new Date(r.created_at).toISOString()
  }));

  function dot(a: number[], b: number[]) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
    return sum;
  }
  function mag(a: number[]) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
    return Math.sqrt(sum);
  }
  function cosine(a: number[], b: number[]) {
    const mA = mag(a);
    const mB = mag(b);
    if (mA === 0 || mB === 0) return 0;
    return dot(a, b) / (mA * mB);
  }

  // ponytail: edges cost O(n²) in JS. At the 1000 cap that is about 500k cosine
  // pairs per request. Leave this comment at the clamp.
  const edges: { a: string; b: string; w: number }[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const eA = embMap.get(nodes[i].id);
      const eB = embMap.get(nodes[j].id);
      if (eA && eB && eA.length > 0 && eA.length === eB.length) {
        const w = cosine(eA, eB);
        if (w >= 0.45) {
          edges.push({ a: nodes[i].id, b: nodes[j].id, w });
        }
      }
    }
  }

  edges.sort((a, b) => b.w - a.w);
  
  return { nodes, edges: edges.slice(0, 200) };
}
