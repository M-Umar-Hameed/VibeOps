import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { embeddings, sessionCursors } from "../../db/schema.js";
import { upsertSourceDocsBatched, appendSourceDoc, EMBED_BATCH } from "../../services/knowledge.js";
import { getEmbedder, type Embedder } from "../../knowledge/embedder.js";
import type { SessionSource } from "./source.js";
import { compressSessionText } from "./compress.js";
import { startJob, type JobCtx } from "../../services/jobs.js";

async function saveCursor(ref: string, c: { offset: number; size: number }) {
  await db.insert(sessionCursors).values({ sourceRef: ref, byteOffset: c.offset, fileSize: c.size })
    .onConflictDoUpdate({ target: sessionCursors.sourceRef, set: { byteOffset: c.offset, fileSize: c.size, updatedAt: new Date() } });
}

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
    const cursorRows = await db.select({ ref: sessionCursors.sourceRef, offset: sessionCursors.byteOffset })
      .from(sessionCursors)
      .where(sql`exists (select 1 from ${embeddings} e where e.source_kind = 'session' and e.source_ref = ${sessionCursors.sourceRef})`);
    const cursors = new Map(cursorRows.map((r) => [r.ref, Number(r.offset)]));

    let docs;
    try {
      docs = await src.listSessionDocs(sinceDays, cursors);
    } catch (e) {
      console.warn(`source ${src.source} failed: ${(e as Error).message}`);
      r.failed++;
      continue;
    }

    ctx?.progress({ phase: `${tag}: checking`, done: 0, total: docs.length });
    let done = 0;
    const changed: typeof docs = [];
    const appends: typeof docs = [];
    for (const doc of docs) {
      if (ctx?.cancelled) break;
      if (doc.append) { appends.push(doc); continue; }
      try {
        const [existing] = await db.select({ h: embeddings.contentHash })
          .from(embeddings)
          .where(and(eq(embeddings.sourceKind, "session"), eq(embeddings.sourceRef, doc.ref)))
          .limit(1);
        if (existing && existing.h === doc.hash) {
          r.skipped++;
          ctx?.progress({ done: ++done });
          if (doc.cursor) await saveCursor(doc.ref, doc.cursor);
        } else {
          changed.push(doc);
        }
      } catch (e) {
        console.warn(`hash check failed for ${doc.ref}: ${(e as Error).message}`);
        r.failed++;
        ctx?.progress({ done: ++done });
      }
    }
    // ponytail: unchanged cursored files produce no doc, so they are not counted in `skipped`.

    if ((changed.length || appends.length) && !ctx?.cancelled) {
      ctx?.progress({ phase: `${tag}: embedding` });
      const byRef = new Map(changed.map((d) => [d.ref, d]));
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
            const d = byRef.get(res.ref);
            if (d?.cursor) {
              try { await saveCursor(d.ref, d.cursor); }
              catch (e) { console.warn(`cursor save failed for ${d.ref}: ${(e as Error).message}`); }
            }
          } else {
            console.warn(`doc ${res.ref} failed: ${res.error}`);
            r.failed++;
          }
        }
        done += changed.length;
      } catch (e) {
        console.warn(`batch ingest failed for ${src.source}: ${(e as Error).message}`);
        r.failed += changed.length;
      }

      for (const doc of appends) {
        if (ctx?.cancelled) break;
        try {
          const text = compressSessionText(doc.text);
          // ponytail: insert and cursor save are separate statements; a crash between them re-appends that delta once (duplicate chunks, never loss).
          if (text.trim()) { await appendSourceDoc("session", doc.ref, text, embedder, doc.hash, doc.projectId); r.indexed++; }
          else r.skipped++;
          await saveCursor(doc.ref, doc.cursor!);
        } catch (e) {
          console.warn(`append failed for ${doc.ref}: ${(e as Error).message}`);
          r.failed++;
        }
        ctx?.progress({ done: ++done });
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
