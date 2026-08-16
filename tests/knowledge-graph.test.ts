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
  const refs: string[] = [];
  // 40 session refs (the high-volume kind) vs 10 each of vault/note/repo. Scoped
  // to exactly these 70 refs so the result is immune to rows other files write
  // into the shared table mid-run — the source of the old "fails only under load".
  for (let i = 0; i < 40; i++) {
    const r = `fs-sess-${i}-${stamp}`;
    await upsertSourceDoc("session", r, `session content ${i}`, emb);
    refs.push(r);
  }
  for (let i = 0; i < 10; i++) {
    const rv = `fs-vault-${i}-${stamp}.md`;
    const rn = `fs-note-${i}-${stamp}`;
    const rr = `fs-repo-${i}-${stamp}.md`;
    await upsertSourceDoc("vault", rv, `vault content ${i}`, emb);
    await upsertSourceDoc("note", rn, `note content ${i}`, emb);
    await upsertSourceDoc("repo", rr, `repo content ${i}`, emb);
    refs.push(rv, rn, rr);
  }
  const res = await knowledgeGraph(60, undefined, refs);
  const byKind = new Map<string, number>();
  for (const n of res.nodes) byKind.set(n.kind, (byKind.get(n.kind) ?? 0) + 1);
  // Round-robin admits every minority kind's full seed (10/10/10) BEFORE session
  // backfills to the 60 cap (30), leaving 10 session refs unused. The 60-node
  // total with session capped at 30 while all four kinds survive is what proves
  // fair-share — and it holds regardless of what the shared table accumulated.
  expect(byKind.get("vault")).toBe(10);
  expect(byKind.get("note")).toBe(10);
  expect(byKind.get("repo")).toBe(10);
  expect(byKind.get("session")).toBe(30);
  expect(res.nodes.length).toBe(60);
  const ids = new Set(res.nodes.map((n) => n.id));
  for (const e of res.edges) {
    expect(ids.has(e.a)).toBe(true);
    expect(ids.has(e.b)).toBe(true);
  }
});

test("knowledgeGraph(projectId) reserves a global floor: 55 repo + 28 global at limit 60", async () => {
  const proj = randomUUID();
  const stamp = Date.now();
  const refs: string[] = [];
  for (let i = 0; i < 55; i++) {
    const r = `${proj}:floor-repo-${i}-${stamp}.md`;
    await upsertSourceDoc("repo", r, `repo doc ${i}`, emb);
    refs.push(r);
  }
  for (let i = 0; i < 28; i++) {
    const r = `floor-sess-${i}-${stamp}`;
    await upsertSourceDoc("session", r, `session ${i}`, emb);
    refs.push(r);
  }
  const res = await knowledgeGraph(60, proj, refs);
  const globalCount = res.nodes.filter((n) => !(n.kind === "repo" && n.id.startsWith(`${proj}:`))).length;
  expect(globalCount).toBeGreaterThanOrEqual(Math.floor(60 * 0.25)); // >= 15
  expect(res.nodes.length).toBe(60);
});

