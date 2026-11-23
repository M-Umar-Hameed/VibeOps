import { expect, test } from "vitest";
import { upsertSourceDoc, searchKnowledge, knowledgeGraph, listSessionDocs } from "../src/services/knowledge.js";
import { randomUUID } from "node:crypto";
import { createProject } from "../src/services/projects.js";
import { saveNote } from "../src/services/notes.js";
import { app } from "../src/api/app.js";
import { FakeEmbedder } from "../src/knowledge/embedder.js";
import { createActor } from "../src/services/actors.js";

const emb = new FakeEmbedder(1024);

async function seed() {
  const k = randomUUID();
  const shared = `# Visibility ${k}\nproject visibility marker`;
  const { actor } = await createActor({ name: "Vis Author", kind: "human", role: "member" });
  const A = await createProject({ key: `visa-${k}`, name: "VisA" });
  const B = await createProject({ key: `visb-${k}`, name: "VisB" });
  const sessA = `vis-sessA-${k}`;
  const sessB = `vis-sessB-${k}`;
  const sessNull = `vis-sessN-${k}`;
  await upsertSourceDoc("session", sessA, shared, emb, undefined, A.id);
  await upsertSourceDoc("session", sessB, shared, emb, undefined, B.id);
  await upsertSourceDoc("session", sessNull, shared, emb, undefined, null);
  const gNote = await saveNote(actor.id, { body: shared, scope: "global" }, emb);
  await upsertSourceDoc("note", gNote.id, shared, emb);
  const aNote = await saveNote(actor.id, { body: shared, scope: "project", refId: A.id }, emb);
  await upsertSourceDoc("note", aNote.id, shared, emb);
  const vault = `vis-vault-${k}.md`;
  await upsertSourceDoc("vault", vault, shared, emb);
  const refs = [sessA, sessB, sessNull, gNote.id, aNote.id, vault];
  return { shared, A, sessA, sessB, sessNull, gNote: gNote.id, aNote: aNote.id, vault, refs };
}

test("searchKnowledge(projectId) shows project, global note and vault; hides other project and unattributed sessions", async () => {
  const s = await seed();
  const refs = (await searchKnowledge(s.shared, { limit: 20, projectId: s.A.id }, emb)).map(r => r.sourceRef);
  for (const r of [s.sessA, s.aNote, s.gNote, s.vault]) expect(refs).toContain(r);
  expect(refs).not.toContain(s.sessB);
  expect(refs).not.toContain(s.sessNull);
});

test("searchKnowledge() unscoped shows all", async () => {
  const s = await seed();
  const refs = (await searchKnowledge(s.shared, { limit: 20 }, emb)).map(r => r.sourceRef);
  for (const r of s.refs) expect(refs).toContain(r);
});

test("knowledgeGraph(projectId) shows project, global note and vault; hides other project and unattributed sessions", async () => {
  const s = await seed();
  const ids = (await knowledgeGraph(60, s.A.id, s.refs)).nodes.map(n => n.id);
  for (const r of [s.sessA, s.aNote, s.gNote, s.vault]) expect(ids).toContain(r);
  expect(ids).not.toContain(s.sessB);
  expect(ids).not.toContain(s.sessNull);
});

test("knowledgeGraph() unscoped shows all", async () => {
  const s = await seed();
  const ids = (await knowledgeGraph(60, undefined, s.refs)).nodes.map(n => n.id);
  for (const r of s.refs) expect(ids).toContain(r);
});

test("listSessionDocs(limit, projectId) filters to the project; unscoped lists all", async () => {
  const s = await seed();
  const scoped = (await listSessionDocs(1000, s.A.id)).map(d => d.ref);
  expect(scoped).toContain(s.sessA);
  expect(scoped).not.toContain(s.sessB);
  expect(scoped).not.toContain(s.sessNull);
  const all = (await listSessionDocs(1000)).map(d => d.ref);
  for (const r of [s.sessA, s.sessB, s.sessNull]) expect(all).toContain(r);
});

test("GET /knowledge/sessions with and without project", async () => {
  const s = await seed();
  const { apiKey } = await createActor({ name: "Vis Route", kind: "human", role: "member" });
  const headers = { Authorization: `Bearer ${apiKey}` };
  const scopedRes = await app.request(`/knowledge/sessions?project=${s.A.id}&limit=1000`, { headers });
  expect(scopedRes.status).toBe(200);
  const scoped = (await scopedRes.json() as { ref: string }[]).map(d => d.ref);
  expect(scoped).toContain(s.sessA);
  expect(scoped).not.toContain(s.sessB);
  expect(scoped).not.toContain(s.sessNull);
  const allRes = await app.request("/knowledge/sessions?limit=1000", { headers });
  expect(allRes.status).toBe(200);
  const all = (await allRes.json() as { ref: string }[]).map(d => d.ref);
  for (const r of [s.sessA, s.sessB, s.sessNull]) expect(all).toContain(r);
});
