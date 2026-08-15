import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { FakeEmbedder } from "../src/knowledge/embedder.js";
import { upsertSourceDoc, searchKnowledge } from "../src/services/knowledge.js";

const emb = new FakeEmbedder(1024);

function seed() {
  const uniq = `chatscope-${Date.now()}-${Math.round(performance.now() * 1000)}`;
  const shared = `# Chat ${uniq}\nchat transcript marker text`;
  const projA = randomUUID();
  const projB = randomUUID();
  const sidA = randomUUID();
  const sidB = randomUUID();
  const sidG = randomUUID();
  return {
    shared, projA, projB,
    aRef: `${projA}:${sidA}`,
    bRef: `${projB}:${sidB}`,
    gRef: sidG, // bare session id => global chat
  };
}

test("project chat is scoped to its project; other project's chat excluded; global chat still returns", async () => {
  const s = seed();
  await upsertSourceDoc("chat", s.aRef, s.shared, emb);
  await upsertSourceDoc("chat", s.bRef, s.shared, emb);
  await upsertSourceDoc("chat", s.gRef, s.shared, emb);

  const refs = (await searchKnowledge(s.shared, { limit: 20, projectId: s.projA }, emb)).map((h) => h.sourceRef);
  expect(refs).toContain(s.aRef);      // own project chat returns
  expect(refs).toContain(s.gRef);      // global (project-less) chat returns
  expect(refs).not.toContain(s.bRef);  // other project's chat excluded
});

test("project-less search still returns all chat (global guard, must not regress)", async () => {
  const s = seed();
  await upsertSourceDoc("chat", s.aRef, s.shared, emb);
  await upsertSourceDoc("chat", s.bRef, s.shared, emb);
  await upsertSourceDoc("chat", s.gRef, s.shared, emb);

  const refs = (await searchKnowledge(s.shared, { limit: 20 }, emb)).map((h) => h.sourceRef);
  expect(refs).toContain(s.aRef);
  expect(refs).toContain(s.bRef);
  expect(refs).toContain(s.gRef);
});
