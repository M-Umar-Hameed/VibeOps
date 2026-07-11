import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { syncLinks, syncCommentLinks } from "../db/schema.js";
import { createTicket, updateTicket } from "../services/tickets.js";
import { addComment } from "../services/comments.js";
import { getTicket } from "../services/history.js";
import { StaleVersionError } from "../services/errors.js";
import { resolveSyncActor } from "./actor.js";
import type { SourceConnector } from "./connector.js";

export type SyncResult = { created: number; updated: number; skipped: number; commentsAdded: number; failed: number };

async function updateOnceWithRetry(
  actorId: string, id: string,
  patch: { title: string; body: string; status: "open" | "in_progress" | "closed" },
): Promise<void> {
  const t = await getTicket(id);
  try {
    await updateTicket(actorId, id, t.version, patch);
  } catch (e) {
    if (!(e instanceof StaleVersionError)) throw e;
    const fresh = await getTicket(id); // retry once with the fresh version
    await updateTicket(actorId, id, fresh.version, patch);
  }
}

export async function runSync(connector: SourceConnector, opts: { projectId: string }): Promise<SyncResult> {
  const actor = await resolveSyncActor(connector.source);
  const res: SyncResult = { created: 0, updated: 0, skipped: 0, commentsAdded: 0, failed: 0 };

  const [latest] = await db.select({ at: syncLinks.externalUpdatedAt }).from(syncLinks)
    .where(eq(syncLinks.source, connector.source)).orderBy(desc(syncLinks.externalUpdatedAt)).limit(1);
  const since = latest?.at ?? undefined;

  const externals = await connector.listExternalTickets(since);
  for (const ext of externals) {
    try {
      const [link] = await db.select().from(syncLinks)
        .where(and(eq(syncLinks.source, connector.source), eq(syncLinks.externalId, ext.externalId))).limit(1);

      let ticketId: string;
      if (!link) {
        const t = await createTicket(actor.id, { projectId: opts.projectId, title: ext.title, body: ext.body });
        if (ext.status !== "open") await updateTicket(actor.id, t.id, t.version, { status: ext.status });
        await db.insert(syncLinks).values({
          source: connector.source, externalId: ext.externalId, ticketId: t.id, externalUpdatedAt: new Date(ext.updatedAt),
        });
        ticketId = t.id;
        res.created++;
      } else {
        ticketId = link.ticketId;
        if (link.externalUpdatedAt && new Date(ext.updatedAt) <= link.externalUpdatedAt) {
          res.skipped++;
        } else {
          await updateOnceWithRetry(actor.id, ticketId, { title: ext.title, body: ext.body, status: ext.status });
          await db.update(syncLinks).set({ externalUpdatedAt: new Date(ext.updatedAt) }).where(eq(syncLinks.id, link.id));
          res.updated++;
        }
      }

      for (const c of ext.comments) {
        const [cl] = await db.select().from(syncCommentLinks)
          .where(and(eq(syncCommentLinks.source, connector.source), eq(syncCommentLinks.externalId, c.externalId))).limit(1);
        if (cl) continue;
        const comment = await addComment(actor.id, ticketId, c.body);
        await db.insert(syncCommentLinks).values({ source: connector.source, externalId: c.externalId, commentId: comment.id });
        res.commentsAdded++;
      }
    } catch (e) {
      console.error(`sync failed for ${ext.externalId}:`, (e as Error).message);
      res.failed++;
    }
  }
  return res;
}
