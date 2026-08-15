import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import * as store from "../src/chat/store.js";
import { setChatAgent, runTurn } from "../src/chat/turns.js";
import { searchKnowledge } from "../src/services/knowledge.js";
import { createActor } from "../src/services/actors.js";
import { db } from "../src/db/client.js";
import { embeddings } from "../src/db/schema.js";

process.env.EMBED_PROVIDER = "fake";

function uniq(p: string) { return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`; }

async function chunkCount(ref: string) {
  const rows = await db.select({ id: embeddings.id }).from(embeddings)
    .where(and(eq(embeddings.sourceKind, "chat"), eq(embeddings.sourceRef, ref)));
  return rows.length;
}

test("completed turn ingests transcript; second turn re-ingests without duplicating", async () => {
  process.env.EMBED_PROVIDER = "fake";
  const { actor } = await createActor({ name: uniq("chat-ingest"), kind: "human" });
  const marker = uniq("MARKER");
  const sess = await store.createSession("ingest test"); // project-less => global ref = sess.id

  setChatAgent(async (params) => {
    params.onData?.("x");
    return { ok: true, text: `assistant reply ${marker}`, sessionId: "sdk-1" };
  });

  await runTurn(actor, sess.id, `user asks ${marker}`);

  const hits1 = await searchKnowledge(marker, { limit: 20 });
  expect(hits1.some((h) => h.sourceRef === sess.id && h.sourceKind === "chat")).toBe(true);
  const c1 = await chunkCount(sess.id);
  expect(c1).toBeGreaterThan(0);

  await runTurn(actor, sess.id, `second ${marker}`);
  const c2 = await chunkCount(sess.id);
  // 4 messages now vs 2 before; a short transcript stays 1 chunk. Assert the ref
  // was REPLACED (single logical doc), not appended: no orphan chunks from turn 1.
  expect(c2).toBeGreaterThan(0);
  const distinctHashes = await db.selectDistinct({ h: embeddings.contentHash }).from(embeddings)
    .where(and(eq(embeddings.sourceKind, "chat"), eq(embeddings.sourceRef, sess.id)));
  expect(distinctHashes.length).toBe(1); // one hash => one live version, prior chunks deleted
});
