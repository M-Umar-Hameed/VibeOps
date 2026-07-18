import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, isNull, inArray, sql as dsql } from "drizzle-orm";
import { db } from "../db/client.js";
import { embeddings, notes } from "../db/schema.js";
import { chunkMarkdown } from "../knowledge/chunker.js";
import { getEmbedder, type Embedder } from "../knowledge/embedder.js";
import { redactSecrets } from "../forge/redact.js";

export function fileHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function fileHashBytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function vecLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

export async function upsertSourceDoc(
  kind: "vault" | "note" | "session", ref: string, text: string,
  embedder: Embedder, contentHash?: string,
): Promise<number> {
  const chunks = chunkMarkdown(text);
  const hash = contentHash ?? fileHash(text);
  const vecs = chunks.length ? await embedder.embed(chunks.map((c) => c.content)) : [];
  const rows = chunks.map((c, i) => ({
    sourceKind: kind, sourceRef: ref, chunkIndex: c.index,
    content: redactSecrets(c.content), embedding: vecs[i], model: embedder.model, dim: embedder.dim,
    contentHash: hash,
  }));
  // One transaction so a mid-batch failure rolls everything back — a partial write
  // would leave rows carrying the new hash and wedge the doc as skipped-forever.
  // Batched inserts: a multi-thousand-row statement overflows PGlite's WASM memory.
  await db.transaction(async (tx) => {
    await tx.delete(embeddings)
      .where(and(eq(embeddings.sourceKind, kind), eq(embeddings.sourceRef, ref)));
    for (let i = 0; i < rows.length; i += 100) {
      await tx.insert(embeddings).values(rows.slice(i, i + 100));
    }
  });
  return chunks.length;
}

export async function upsertVaultFile(path: string, text: string, embedder: Embedder, contentHash?: string): Promise<number> {
  return upsertSourceDoc("vault", path, text, embedder, contentHash);
}

export async function deleteVaultFile(path: string): Promise<void> {
  await db.delete(embeddings)
    .where(and(eq(embeddings.sourceKind, "vault"), eq(embeddings.sourceRef, path)));
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
    const [current] = await tx.select({ body: notes.body, deletedAt: notes.deletedAt })
      .from(notes).where(eq(notes.id, noteId)).limit(1);
    if (!current || current.deletedAt || current.body !== body) return false; // stale writer: no-op
    await tx.delete(embeddings)
      .where(and(eq(embeddings.sourceKind, "note"), eq(embeddings.sourceRef, noteId)));
    await tx.insert(embeddings).values(parts.map((c, i) => ({
      sourceKind: "note" as const, sourceRef: noteId, chunkIndex: c.index,
      content: redactSecrets(c.content), embedding: vecs[i], model: embedder.model, dim: embedder.dim,
      contentHash: hash,
    })));
    return true;
  });
}

export async function searchKnowledge(
  query: string,
  opts: { limit?: number } = {},
  embedder: Embedder = getEmbedder(),
): Promise<{ content: string; sourceKind: string; sourceRef: string; score: number; citation: string; createdAt: string }[]> {
  const [qv] = await embedder.embed([query]);
  const limit = opts.limit ?? 5;
  const lit = vecLiteral(qv);
  // Cosine distance; filter to active dim so mixed-dim rows never compare.
  // SET LOCAL needs the same connection as the query, hence the transaction.
  // ef_search 100 (default 40): the dim filter runs AFTER the ANN scan, so
  // mixed-dim/mixed-source indexes need a wider candidate pool or exact
  // matches fall out of the top-k as the table grows.
  // Inner query does the ANN scan (cheap, index-assisted) over a wider
  // candidate pool; outer query re-ranks that pool by recency-decayed score
  // so the HNSW index is never asked to order by anything but distance.
  const res: unknown = await db.transaction(async (tx) => {
    await tx.execute(dsql`set local hnsw.ef_search = 100`);
    return tx.execute(dsql`
    select source_kind, source_ref, content, created_at,
           (1 - cosine_distance) * (1.0 / (1.0 + extract(epoch from (now() - created_at)) / (86400.0 * 90))) as score
    from (
      select source_kind, source_ref, content, created_at,
             embedding <=> ${lit}::vector as cosine_distance
      from embeddings
      where dim = ${embedder.dim}
      order by embedding <=> ${lit}::vector
      limit ${limit * 4}
    ) candidates
    order by score desc
    limit ${limit}`);
  });
  const rows = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as any[];
  return rows.map((r: any) => ({
    content: r.content, sourceKind: r.source_kind, sourceRef: r.source_ref,
    score: Number(r.score), citation: r.source_ref,
    createdAt: new Date(r.created_at).toISOString(),
  }));
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

export async function getKnowledgeSource(kind: string, ref: string): Promise<string> {
  if (kind === "vault") {
    // Only serve refs that exist in the knowledge index (exact sourceRef match).
    // Without this check the endpoint is an arbitrary file read for any actor.
    const [indexed] = await db.select({ id: embeddings.id }).from(embeddings)
      .where(and(eq(embeddings.sourceKind, "vault"), eq(embeddings.sourceRef, ref))).limit(1);
    if (!indexed) return `Error: ${ref} is not an indexed vault source.`;
    try {
      return await readFile(ref, "utf-8");
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
    // Ingested sessions have no source file to read back; the indexed chunks
    // ARE the source. Reassemble them in order.
    const rows = await db.select({ content: embeddings.content })
      .from(embeddings)
      .where(and(eq(embeddings.sourceKind, "session"), eq(embeddings.sourceRef, ref)))
      .orderBy(embeddings.chunkIndex);
    if (!rows.length) return `Error: Session ${ref} not found in the index.`;
    return rows.map((r) => r.content).join("\n\n");
  }
  return `Error: Unknown source kind ${kind}`;
}

export async function knowledgeGraph(limit = 60): Promise<{ nodes: { id: string; kind: string; chunks: number; createdAt: string }[]; edges: { a: string; b: string; w: number }[] }> {
  const aggRows: unknown = await db.execute(dsql`
    SELECT source_ref, source_kind, count(id) as chunk_count, max(created_at) as created_at
    FROM embeddings
    GROUP BY source_ref, source_kind
    ORDER BY max(created_at) DESC
    LIMIT ${limit}
  `);

  const rows = (Array.isArray(aggRows) ? aggRows : (aggRows as { rows: unknown[] }).rows) as any[];
  if (!rows.length) return { nodes: [], edges: [] };

  const refs = rows.map(r => String(r.source_ref));
  const chunkRows = await db.select({ sourceRef: embeddings.sourceRef, embedding: dsql<string>`${embeddings.embedding}::text` })
    .from(embeddings)
    .where(and(eq(embeddings.chunkIndex, 0), inArray(embeddings.sourceRef, refs)));

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
