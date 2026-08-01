import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { FakeEmbedder } from "../src/knowledge/embedder.js";
import { upsertSourceDoc, upsertVaultFile, searchKnowledge } from "../src/services/knowledge.js";

const emb = new FakeEmbedder(1024);

// FakeEmbedder hashes text -> identical text = identical vector (distance 0).
// A per-run unique marker isolates these rows from the shared embeddings table.
function seedRefs() {
  const uniq = `scope-${Date.now()}-${Math.round(performance.now() * 1000)}`;
  const shared = `# Scope ${uniq}\ncross project marker text`;
  const projA = randomUUID();
  const projB = randomUUID();
  const aRef = `${projA}:a.md`;
  const bRef = `${projB}:b.md`;
  const vaultRef = `vault-${uniq}.md`;
  return { uniq, shared, projA, projB, aRef, bRef, vaultRef };
}

test("projectId scopes out other projects' repo chunks, keeps global", async () => {
  const s = seedRefs();
  await upsertSourceDoc("repo", s.aRef, s.shared, emb);
  await upsertSourceDoc("repo", s.bRef, s.shared, emb);
  await upsertVaultFile(s.vaultRef, s.shared, emb);

  const hits = await searchKnowledge(s.shared, { limit: 20, projectId: s.projA }, emb);
  const refs = hits.map((h) => h.sourceRef);
  expect(refs).toContain(s.aRef);       // own project repo returns
  expect(refs).toContain(s.vaultRef);   // global vault still returns
  expect(refs).not.toContain(s.bRef);   // other project repo excluded
});

test("no projectId behaves as today (all projects returned)", async () => {
  const s = seedRefs();
  await upsertSourceDoc("repo", s.aRef, s.shared, emb);
  await upsertSourceDoc("repo", s.bRef, s.shared, emb);
  await upsertVaultFile(s.vaultRef, s.shared, emb);

  const refs = (await searchKnowledge(s.shared, { limit: 20 }, emb)).map((h) => h.sourceRef);
  expect(refs).toContain(s.aRef);
  expect(refs).toContain(s.bRef);       // B present when unscoped
  expect(refs).toContain(s.vaultRef);
});
