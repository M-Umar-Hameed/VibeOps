import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { embeddings } from "../../db/schema.js";
import { upsertSourceDoc } from "../../services/knowledge.js";
import { getEmbedder, type Embedder } from "../../knowledge/embedder.js";
import type { SessionSource } from "./source.js";
import { compressSessionText } from "./compress.js";

export async function ingestSessions(
  sources: SessionSource[],
  embedder: Embedder = getEmbedder(),
  sinceDays = 30,
): Promise<Record<string, { indexed: number; skipped: number; failed: number }>> {
  const result: Record<string, { indexed: number; skipped: number; failed: number }> = {};
  for (const src of sources) {
    const r = { indexed: 0, skipped: 0, failed: 0 };
    result[src.source] = r;
    let docs;
    try { docs = await src.listSessionDocs(sinceDays); }
    catch (e) { console.warn(`source ${src.source} failed: ${(e as Error).message}`); r.failed++; continue; }
    for (const doc of docs) {
      try {
        const [existing] = await db.select({ h: embeddings.contentHash }).from(embeddings)
          .where(and(eq(embeddings.sourceKind, "session"), eq(embeddings.sourceRef, doc.ref))).limit(1);
        if (existing && existing.h === doc.hash) { r.skipped++; continue; }
        await upsertSourceDoc("session", doc.ref, compressSessionText(doc.text), embedder, doc.hash);
        r.indexed++;
      } catch (e) {
        console.warn(`doc ${doc.ref} failed: ${(e as Error).message}`);
        r.failed++;
      }
    }
  }
  return result;
}

// Single in-process guard shared by the manual Sync route and the auto-sync timer:
// if one run holds it, the other skips (returns null) rather than double-ingesting.
let sessionIngestRunning = false;

export async function ingestSessionsSerialized(
  sources: SessionSource[],
  embedder: Embedder = getEmbedder(),
  sinceDays = 30,
): Promise<Record<string, { indexed: number; skipped: number; failed: number }> | null> {
  if (sessionIngestRunning) return null;
  sessionIngestRunning = true;
  try {
    return await ingestSessions(sources, embedder, sinceDays);
  } finally {
    sessionIngestRunning = false;
  }
}
