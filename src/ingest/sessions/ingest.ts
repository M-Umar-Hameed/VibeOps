import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { embeddings } from "../../db/schema.js";
import { upsertSourceDocsBatched, EMBED_BATCH } from "../../services/knowledge.js";
import { getEmbedder, type Embedder } from "../../knowledge/embedder.js";
import type { SessionSource } from "./source.js";
import { compressSessionText } from "./compress.js";
import { startJob, type JobCtx } from "../../services/jobs.js";

export async function ingestSessions(
  sources: SessionSource[],
  embedder: Embedder = getEmbedder(),
  sinceDays = 30,
  ctx?: JobCtx,
): Promise<Record<string, { indexed: number; skipped: number; failed: number }>> {
  const result: Record<string, { indexed: number; skipped: number; failed: number }> = {};
  for (const [si, src] of sources.entries()) {
    if (ctx?.cancelled) break;
    const tag = `${src.source} (${si + 1}/${sources.length})`;
    const r = { indexed: 0, skipped: 0, failed: 0 };
    result[src.source] = r;

    ctx?.progress({ phase: `${tag}: listing`, done: null, total: null });
    let docs;
    try {
      docs = await src.listSessionDocs(sinceDays);
    } catch (e) {
      console.warn(`source ${src.source} failed: ${(e as Error).message}`);
      r.failed++;
      continue;
    }

    ctx?.progress({ phase: `${tag}: checking`, done: 0, total: docs.length });
    let done = 0;
    const changed: typeof docs = [];
    for (const doc of docs) {
      if (ctx?.cancelled) break;
      try {
        const [existing] = await db.select({ h: embeddings.contentHash })
          .from(embeddings)
          .where(and(eq(embeddings.sourceKind, "session"), eq(embeddings.sourceRef, doc.ref)))
          .limit(1);
        if (existing && existing.h === doc.hash) {
          r.skipped++;
          ctx?.progress({ done: ++done });
        } else {
          changed.push(doc);
        }
      } catch (e) {
        console.warn(`hash check failed for ${doc.ref}: ${(e as Error).message}`);
        r.failed++;
        ctx?.progress({ done: ++done });
      }
    }

    if (changed.length && !ctx?.cancelled) {
      ctx?.progress({ phase: `${tag}: embedding` });
      try {
        const results = await upsertSourceDocsBatched(
          "session",
          changed.map((d) => ({ ref: d.ref, text: compressSessionText(d.text), contentHash: d.hash, projectId: d.projectId })),
          embedder,
          EMBED_BATCH,
          {
            onDoc: (n) => ctx?.progress({ done: done + n }),
            isCancelled: () => !!ctx?.cancelled,
          },
        );
        for (const res of results) {
          if (res.ok) {
            r.indexed++;
          } else {
            console.warn(`doc ${res.ref} failed: ${res.error}`);
            r.failed++;
          }
        }
      } catch (e) {
        console.warn(`batch ingest failed for ${src.source}: ${(e as Error).message}`);
        r.failed += changed.length;
      }
    }
  }
  return result;
}

export function startSessionIngestJob(
  sources: SessionSource[],
  embedder: Embedder = getEmbedder(),
  sinceDays = 30,
  trigger: "manual" | "auto" = "manual",
) {
  return startJob(
    "sessions",
    "sessions",
    trigger === "auto" ? "Auto-sync sweep" : "Sync sessions",
    (ctx) => ingestSessions(sources, embedder, sinceDays, ctx),
    { trigger, cancellable: true },
  );
}

// Shared guard (manual route + auto-sync): a second caller gets null instead of double-ingesting.
export async function ingestSessionsSerialized(
  sources: SessionSource[],
  embedder: Embedder = getEmbedder(),
  sinceDays = 30,
  trigger: "manual" | "auto" = "manual",
): Promise<Record<string, { indexed: number; skipped: number; failed: number }> | null> {
  const { promise, existing } = startSessionIngestJob(sources, embedder, sinceDays, trigger);
  return existing ? null : await promise;
}
