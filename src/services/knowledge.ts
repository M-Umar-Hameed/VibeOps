import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, sql as dsql } from "drizzle-orm";
import { db } from "../db/client.js";
import { embeddings, notes } from "../db/schema.js";
import { chunkMarkdown } from "../knowledge/chunker.js";
import { getEmbedder, type Embedder } from "../knowledge/embedder.js";

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
    content: c.content, embedding: vecs[i], model: embedder.model, dim: embedder.dim,
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

export async function insertNoteEmbedding(noteId: string, body: string, embedder: Embedder): Promise<void> {
  const chunks = chunkMarkdown(body);
  const hash = fileHash(body);
  await db.delete(embeddings)
    .where(and(eq(embeddings.sourceKind, "note"), eq(embeddings.sourceRef, noteId)));
  const parts = chunks.length ? chunks : [{ index: 0, content: body }];
  const vecs = await embedder.embed(parts.map((c) => c.content));
  await db.insert(embeddings).values(parts.map((c, i) => ({
    sourceKind: "note" as const, sourceRef: noteId, chunkIndex: c.index,
    content: c.content, embedding: vecs[i], model: embedder.model, dim: embedder.dim,
    contentHash: hash,
  })));
}

export async function searchKnowledge(
  query: string,
  opts: { limit?: number } = {},
  embedder: Embedder = getEmbedder(),
): Promise<{ content: string; sourceKind: string; sourceRef: string; score: number; citation: string }[]> {
  const [qv] = await embedder.embed([query]);
  const limit = opts.limit ?? 5;
  const lit = vecLiteral(qv);
  // Cosine distance; filter to active dim so mixed-dim rows never compare.
  const res: unknown = await db.execute(dsql`
    select source_kind, source_ref, content,
           1 - (embedding <=> ${lit}::vector) as score
    from embeddings
    where dim = ${embedder.dim}
    order by embedding <=> ${lit}::vector
    limit ${limit}`);
  const rows = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as any[];
  return rows.map((r: any) => ({
    content: r.content, sourceKind: r.source_kind, sourceRef: r.source_ref,
    score: Number(r.score), citation: r.source_ref,
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
      const [noteRow] = await db.select({ body: notes.body }).from(notes).where(eq(notes.id, ref)).limit(1);
      return noteRow ? noteRow.body : `Error: Note ${ref} not found.`;
    } catch (e: any) {
      return `Error: DB query failed: ${e.message}`;
    }
  }
  return `Error: Unknown source kind ${kind}`;
}
