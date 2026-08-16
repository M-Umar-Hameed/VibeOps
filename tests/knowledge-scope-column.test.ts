import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { sql as dsql, inArray } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { embeddings, notes, projects, tickets } from "../src/db/schema.js";
import {
  backfillEmbeddingProjectIds,
  searchKnowledge,
  upsertSourceDoc,
} from "../src/services/knowledge.js";
import { createActor } from "../src/services/actors.js";
import { FakeEmbedder } from "../src/knowledge/embedder.js";

async function getSortedRefs(predicate: ReturnType<typeof dsql>, refs: string[]): Promise<string[]> {
  const res: unknown = await db.execute(dsql`
    SELECT source_ref
    FROM embeddings
    WHERE ${predicate}
      AND ${inArray(embeddings.sourceRef, refs)}
    ORDER BY source_ref ASC
  `);
  const rows = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as { source_ref: string }[];
  return rows.map((r) => r.source_ref);
}

test("Test A: parity oracle matches column-based predicate for project and global scope", async () => {
  const k = randomUUID();
  const { actor } = await createActor({ name: `Scope Parity ${k}`, kind: "human" });

  const [projA] = await db.insert(projects).values({ key: `pa-${k}`, name: `Proj A ${k}` }).returning();
  const [projB] = await db.insert(projects).values({ key: `pb-${k}`, name: `Proj B ${k}` }).returning();
  const A = projA.id;
  const B = projB.id;

  const [ticketA] = await db.insert(tickets).values({
    projectId: A,
    title: `Ticket A ${k}`,
  }).returning();

  const [noteProj] = await db.insert(notes).values({
    actorId: actor.id,
    body: `project note body ${k}`,
    scope: "project",
    refId: A,
  }).returning();

  const [noteTick] = await db.insert(notes).values({
    actorId: actor.id,
    body: `ticket note body ${k}`,
    scope: "ticket",
    refId: ticketA.id,
  }).returning();

  const [noteGlob] = await db.insert(notes).values({
    actorId: actor.id,
    body: `global note body ${k}`,
    scope: "global",
  }).returning();

  const repoARef = `${A}:src/x-${k}.md`;
  const vaultARef = `${A}:v-${k}.md`;
  const vaultBareRef = `legacy-${k}.md`;
  const chatARef = `${A}:${randomUUID()}`;
  const chatBareRef = `${k}`;
  const sessBareRef = `sess-${k}`;
  const noteProjRef = noteProj.id;
  const noteTickRef = noteTick.id;
  const noteGlobRef = noteGlob.id;
  const repoBRef = `${B}:z-${k}.md`;

  const dummyVec = [1, ...new Array(1023).fill(0)];

  const seedSpecs = [
    { kind: "repo" as const, ref: repoARef },
    { kind: "vault" as const, ref: vaultARef },
    { kind: "vault" as const, ref: vaultBareRef },
    { kind: "chat" as const, ref: chatARef },
    { kind: "chat" as const, ref: chatBareRef },
    { kind: "session" as const, ref: sessBareRef },
    { kind: "note" as const, ref: noteProjRef },
    { kind: "note" as const, ref: noteTickRef },
    { kind: "note" as const, ref: noteGlobRef },
    { kind: "repo" as const, ref: repoBRef },
  ];

  for (const s of seedSpecs) {
    await db.insert(embeddings).values({
      sourceKind: s.kind,
      sourceRef: s.ref,
      chunkIndex: 0,
      content: `content for ${s.ref}`,
      embedding: dummyVec,
      model: "test",
      dim: 1024,
      contentHash: `hash-${s.ref}`,
      projectId: null,
    });
  }

  const allRefs = seedSpecs.map((s) => s.ref);

  // Run backfill to populate projectId from legacy conventions
  await backfillEmbeddingProjectIds();

  // Oracle SQL (legacy regex-based)
  const oracleProject = dsql`(
    ( (source_kind='repo'  AND source_ref LIKE ${A + ":%"})
      OR (source_kind='vault' AND source_ref LIKE ${A + ":%"})
      OR (source_kind='chat'  AND source_ref LIKE ${A + ":%"})
      OR (source_kind='note' AND source_ref IN (
          SELECT n.id::text FROM notes n LEFT JOIN tickets t ON t.id = n.ref_id
          WHERE n.deleted_at IS NULL AND (
            (n.scope='project' AND n.ref_id=${A}::uuid)
            OR (n.scope='ticket' AND t.project_id=${A}::uuid))))
    )
    OR
    ( source_kind='session'
      OR (source_kind='chat'  AND source_ref !~ '^[0-9a-fA-F-]{36}:')
      OR (source_kind='vault' AND source_ref !~ '^[0-9a-fA-F-]{36}:')
      OR (source_kind='note' AND source_ref IN (
          SELECT n.id::text FROM notes n WHERE n.deleted_at IS NULL AND n.scope='global')))
  )`;

  const oracleGlobal = dsql`(
    source_kind='session'
    OR (source_kind='chat'  AND source_ref !~ '^[0-9a-fA-F-]{36}:')
    OR (source_kind='vault' AND source_ref !~ '^[0-9a-fA-F-]{36}:')
    OR (source_kind='note' AND source_ref IN (
        SELECT n.id::text FROM notes n WHERE n.deleted_at IS NULL AND n.scope='global'))
  )`;

  const newProject = dsql`(project_id = ${A}::uuid OR project_id IS NULL)`;
  const newGlobal = dsql`(project_id IS NULL)`;

  const oracleProjectHits = await getSortedRefs(oracleProject, allRefs);
  const newProjectHits = await getSortedRefs(newProject, allRefs);
  expect(newProjectHits).toEqual(oracleProjectHits);
  expect(newProjectHits.length).toBe(9);
  expect(newProjectHits).not.toContain(repoBRef);

  const oracleGlobalHits = await getSortedRefs(oracleGlobal, allRefs);
  const newGlobalHits = await getSortedRefs(newGlobal, allRefs);
  expect(newGlobalHits).toEqual(oracleGlobalHits);
  expect(newGlobalHits.length).toBe(4);
});

test("Test B: cross-project search returns project A rows and excludes project B rows", async () => {
  const emb = new FakeEmbedder(1024);
  const k = randomUUID();
  const projA = randomUUID();
  const projB = randomUUID();
  const shared = `# Cross Project Search ${k}\nUnique shared marker content for search`;
  const aRef = `${projA}:a-${k}.md`;
  const bRef = `${projB}:b-${k}.md`;

  await upsertSourceDoc("repo", aRef, shared, emb);
  await upsertSourceDoc("repo", bRef, shared, emb);

  const hits = await searchKnowledge(shared, { limit: 20, projectId: projA }, emb);
  const refs = hits.map((h) => h.sourceRef);
  expect(refs).toContain(aRef);
  expect(refs).not.toContain(bRef);
});

test("Test C: backfill idempotency - second run makes no changes and preserves snapshot", async () => {
  const k = randomUUID();
  const { actor } = await createActor({ name: `Idem Tester ${k}`, kind: "human" });
  const [proj] = await db.insert(projects).values({ key: `idm-${k}`, name: `Idempotency ${k}` }).returning();
  const [noteProj] = await db.insert(notes).values({
    actorId: actor.id,
    body: `note proj ${k}`,
    scope: "project",
    refId: proj.id,
  }).returning();
  const [noteGlob] = await db.insert(notes).values({
    actorId: actor.id,
    body: `note glob ${k}`,
    scope: "global",
  }).returning();

  const repoRef = `${proj.id}:repo-${k}.md`;
  const sessRef = `sess-${k}`;

  const dummyVec = [1, ...new Array(1023).fill(0)];
  const [rowRepo] = await db.insert(embeddings).values({
    sourceKind: "repo",
    sourceRef: repoRef,
    chunkIndex: 0,
    content: "repo doc",
    embedding: dummyVec,
    model: "test",
    dim: 1024,
    contentHash: `hash-repo-${k}`,
    projectId: null,
  }).returning();

  const [rowProjNote] = await db.insert(embeddings).values({
    sourceKind: "note",
    sourceRef: noteProj.id,
    chunkIndex: 0,
    content: "proj note",
    embedding: dummyVec,
    model: "test",
    dim: 1024,
    contentHash: `hash-pn-${k}`,
    projectId: null,
  }).returning();

  const [rowGlobNote] = await db.insert(embeddings).values({
    sourceKind: "note",
    sourceRef: noteGlob.id,
    chunkIndex: 0,
    content: "glob note",
    embedding: dummyVec,
    model: "test",
    dim: 1024,
    contentHash: `hash-gn-${k}`,
    projectId: null,
  }).returning();

  const [rowSess] = await db.insert(embeddings).values({
    sourceKind: "session",
    sourceRef: sessRef,
    chunkIndex: 0,
    content: "session doc",
    embedding: dummyVec,
    model: "test",
    dim: 1024,
    contentHash: `hash-sess-${k}`,
    projectId: null,
  }).returning();

  const targetIds = [rowRepo.id, rowProjNote.id, rowGlobNote.id, rowSess.id];

  await backfillEmbeddingProjectIds();

  const rows1 = await db.select({ id: embeddings.id, projectId: embeddings.projectId })
    .from(embeddings)
    .where(inArray(embeddings.id, targetIds));
  const snap1 = new Map(rows1.map((r) => [r.id, r.projectId]));

  // Verify first run did real work
  expect(snap1.get(rowRepo.id)).toBe(proj.id);
  expect(snap1.get(rowProjNote.id)).toBe(proj.id);
  expect(snap1.get(rowGlobNote.id)).toBeNull();
  expect(snap1.get(rowSess.id)).toBeNull();

  // Second run
  await backfillEmbeddingProjectIds();

  const rows2 = await db.select({ id: embeddings.id, projectId: embeddings.projectId })
    .from(embeddings)
    .where(inArray(embeddings.id, targetIds));
  const snap2 = new Map(rows2.map((r) => [r.id, r.projectId]));

  expect(snap2).toEqual(snap1);
});
