import { expect, test, vi } from "vitest";
import { upsertSourceDoc, knowledgeGraph } from "../src/services/knowledge.js";
import { randomUUID } from "node:crypto";
import { createProject } from "../src/services/projects.js";
import { saveNote } from "../src/services/notes.js";
import { app } from "../src/api/app.js";
import { FakeEmbedder } from "../src/knowledge/embedder.js";
import { createActor } from "../src/services/actors.js";

const emb = new FakeEmbedder(1024);


test("knowledgeGraph returns nodes and edges with twin similarities", async () => {
  const ref1 = `graph-twin-1-${Date.now()}`;
  const ref2 = `graph-twin-2-${Date.now()}`;
  const ref3 = `graph-unique-${Date.now()}`;
  
  await upsertSourceDoc("session", ref1, "identical content for testing twins", emb);
  await upsertSourceDoc("session", ref2, "identical content for testing twins", emb);
  await upsertSourceDoc("session", ref3, "completely different random string", emb);
  
  const res = await knowledgeGraph(60, undefined, [ref1, ref2, ref3]);
  expect(res.nodes.length).toBeGreaterThanOrEqual(3);
  
  const edge = res.edges.find(e => 
    (e.a === ref1 && e.b === ref2) || (e.a === ref2 && e.b === ref1)
  );
  expect(edge).toBeDefined();
  expect(edge!.w).toBeGreaterThan(0.9);
  
  const capped = await knowledgeGraph(2, undefined, [ref1, ref2, ref3]);
  expect(capped.nodes.length).toBeLessThanOrEqual(2);
});

test("GET /knowledge/graph returns 200", async () => {
  const { apiKey } = await createActor({ name: "Graph Tester", kind: "human", role: "member" });
  
  const res = await app.request("/knowledge/graph?limit=5", {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  
  expect(res.status).toBe(200);
});

test("knowledgeGraph(projectId) returns only that project's repo nodes, with vault/session still shown", async () => {
  const pA = randomUUID();
  const pB = randomUUID();
  const vaultRef = `vault-shared-${Date.now()}.md`;
  const sessRef = `session-shared-${Date.now()}`;
  await upsertSourceDoc("repo", `${pA}:README.md`, "alpha repo docs", emb);
  await upsertSourceDoc("repo", `${pB}:README.md`, "beta repo docs", emb);
  await upsertSourceDoc("vault", vaultRef, "shared vault content", emb);
  await upsertSourceDoc("session", sessRef, "shared session content", emb);

  const res = await knowledgeGraph(200, pA, [`${pA}:README.md`, `${pB}:README.md`, vaultRef, sessRef]);
  const ids = res.nodes.map(n => n.id);
  expect(ids).toContain(`${pA}:README.md`);
  expect(ids).not.toContain(`${pB}:README.md`);
  expect(ids).toContain(vaultRef);
  expect(ids).toContain(sessRef);
});

test("knowledgeGraph() with no projectId includes repo nodes for any project (unchanged)", async () => {
  const p = randomUUID();
  const ref = `${p}:UNFILTERED.md`;
  await upsertSourceDoc("repo", ref, "repo doc no filter", emb);
  const res = await knowledgeGraph(200, undefined, [ref]);
  expect(res.nodes.map(n => n.id)).toContain(ref);
});

test("knowledgeGraph(projectId) includes project-scoped notes and excludes another project's notes", async () => {
  const { actor } = await createActor({ name: "Notes Author", kind: "human", role: "member" });
  const pA = await createProject({ key: `ka-${randomUUID()}`, name: "A" });
  const pB = await createProject({ key: `kb-${randomUUID()}`, name: "B" });
  const nA = await saveNote(actor.id, { body: "knowledge for A", scope: "project", refId: pA.id }, emb);
  const nB = await saveNote(actor.id, { body: "knowledge for B", scope: "project", refId: pB.id }, emb);
  const res = await knowledgeGraph(200, pA.id);
  const ids = res.nodes.map(n => n.id);
  expect(ids).toContain(nA.id);
  expect(ids).not.toContain(nB.id);
});

test("knowledgeGraph(projectId) budgets project nodes first: 5 repo + 55 global at limit 60", async () => {
  const proj = randomUUID();
  const stamp = Date.now();
  for (let i = 0; i < 5; i++) {
    await upsertSourceDoc("repo", `${proj}:file-${i}-${stamp}.md`, `project repo doc ${i}`, emb);
  }
  for (let i = 0; i < 100; i++) {
    await upsertSourceDoc("session", `budget-sess-${i}-${stamp}`, `global session ${i}`, emb);
  }
  const res = await knowledgeGraph(60, proj);
  const repoIds = res.nodes.filter(n => n.kind === "repo" && n.id.startsWith(`${proj}:`)).map(n => n.id);
  expect(repoIds.length).toBe(5);
  for (let i = 0; i < 5; i++) {
    expect(res.nodes.map(n => n.id)).toContain(`${proj}:file-${i}-${stamp}.md`);
  }
  expect(res.nodes.length).toBe(60);
  const globalCount = res.nodes.filter(n => !(n.kind === "repo" && n.id.startsWith(`${proj}:`))).length;
  expect(globalCount).toBe(55);
});

test("knowledgeGraph() no-project unchanged: newest global session appears", async () => {
  const sess = `noproj-sess-${Date.now()}`;
  await upsertSourceDoc("session", sess, "no-project session content", emb);
  const res = await knowledgeGraph(200, undefined, [sess]);
  expect(res.nodes.map(n => n.id)).toContain(sess);
});

test("knowledgeGraph edges only reference returned nodes", async () => {
  const proj = randomUUID();
  const stamp = Date.now();
  await upsertSourceDoc("repo", `${proj}:a-${stamp}.md`, "shared graph content here", emb);
  await upsertSourceDoc("session", `edge-sess-${stamp}`, "shared graph content here", emb);
  const res = await knowledgeGraph(60, proj);
  const ids = new Set(res.nodes.map(n => n.id));
  for (const e of res.edges) {
    expect(ids.has(e.a)).toBe(true);
    expect(ids.has(e.b)).toBe(true);
  }
});

test("knowledgeGraph() no-project fair-shares budget across all four kinds", async () => {
  const stamp = Date.now();
  for (let i = 0; i < 300; i++) {
    await upsertSourceDoc("session", `fs-sess-${i}-${stamp}`, `session content ${i}`, emb);
  }
  for (let i = 0; i < 10; i++) {
    await upsertSourceDoc("vault", `fs-vault-${i}-${stamp}.md`, `vault content ${i}`, emb);
    await upsertSourceDoc("note", `fs-note-${i}-${stamp}`, `note content ${i}`, emb);
    await upsertSourceDoc("repo", `fs-repo-${i}-${stamp}.md`, `repo content ${i}`, emb);
  }
  const res = await knowledgeGraph(60);
  const kinds = new Set(res.nodes.map((n) => n.kind));
  expect(kinds.has("session")).toBe(true);
  expect(kinds.has("vault")).toBe(true);
  expect(kinds.has("note")).toBe(true);
  expect(kinds.has("repo")).toBe(true);
  expect(res.nodes.length).toBe(60);
  const ids = new Set(res.nodes.map((n) => n.id));
  for (const e of res.edges) {
    expect(ids.has(e.a)).toBe(true);
    expect(ids.has(e.b)).toBe(true);
  }
}, 30000);
