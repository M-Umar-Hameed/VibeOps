import { expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { notes, embeddings } from "../src/db/schema.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { saveNote, updateNote, noteIndexText } from "../src/services/notes.js";
import { FakeEmbedder } from "../src/knowledge/embedder.js";

const emb = new FakeEmbedder(1024);
const uniq = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

test("saveNote defaults keep plain notes unchanged", async () => {
  const { actor } = await createActor({ name: uniq("mem-default"), kind: "agent" });
  const n = await saveNote(actor.id, { body: "plain", scope: "global" }, emb);
  expect(n.kind).toBe("note");
  expect(n.domain).toBeNull();
  expect(n.rationale).toBeNull();
  expect(n.source).toBe("manual");
});

test("saveNote stores kind, lowercased domain, rationale and source", async () => {
  const { actor } = await createActor({ name: uniq("mem-typed"), kind: "agent" });
  const project = await createProject({ key: uniq("k"), name: uniq("proj") });
  const d = await saveNote(actor.id, {
    body: "Heartbeat via chrome.alarms at 30s", scope: "project", refId: project.id,
    kind: "decision", domain: "Extension", rationale: "MV3 kills idle workers", source: "auto",
  }, emb);
  expect(d.kind).toBe("decision");
  expect(d.domain).toBe("extension");
  expect(d.rationale).toBe("MV3 kills idle workers");
  expect(d.source).toBe("auto");
  const [row] = await db.select().from(notes).where(eq(notes.id, d.id));
  expect(row.kind).toBe("decision");
});

test("noteIndexText folds the rationale into what gets embedded, for decisions only", () => {
  expect(noteIndexText({ body: "Use X", kind: "decision", rationale: "because Y" })).toBe("Use X\nRationale: because Y");
  expect(noteIndexText({ body: "Use X", kind: "decision", rationale: null })).toBe("Use X");
  expect(noteIndexText({ body: "Always Z", kind: "rule", rationale: "ignored" })).toBe("Always Z");
});

test("updateNote can patch kind to rule with a domain; row updates and indexed flips false until re-embedded", async () => {
  const { actor } = await createActor({ name: uniq("mem-patch-kind"), kind: "agent" });
  const note = await saveNote(actor.id, { body: "plain", scope: "global" }, emb);
  const boom: any = { model: "boom", dim: 1024, embed: async () => { throw new Error("api down"); } };
  const updated = await updateNote(actor.id, note.id, note.version, { kind: "rule", domain: "Extension" }, boom);
  expect(updated.kind).toBe("rule");
  expect(updated.domain).toBe("extension");
  expect(updated.indexed).toBe(false);
  const [row] = await db.select().from(notes).where(eq(notes.id, note.id));
  expect(row.kind).toBe("rule");
  expect(row.domain).toBe("extension");
  expect(row.indexed).toBe(false);
});

test("updateNote rejects an invalid kind, naming the valid kinds", async () => {
  const { actor } = await createActor({ name: uniq("mem-bad-kind"), kind: "agent" });
  const note = await saveNote(actor.id, { body: "plain", scope: "global" }, emb);
  await expect(
    updateNote(actor.id, note.id, note.version, { kind: "bogus" as any }, emb),
  ).rejects.toThrow(/note, decision, rule, handoff/);
});

test("patching rationale on a decision re-embeds body+rationale", async () => {
  const { actor } = await createActor({ name: uniq("mem-patch-rationale"), kind: "agent" });
  const note = await saveNote(actor.id, {
    body: "Use X", scope: "global", kind: "decision", rationale: "first reason",
  }, emb);
  const updated = await updateNote(actor.id, note.id, note.version, { rationale: "second reason" }, emb);
  expect(updated.rationale).toBe("second reason");
  expect(updated.indexed).toBe(true);
  const embs = await db.select().from(embeddings).where(eq(embeddings.sourceRef, note.id));
  expect(embs.length).toBeGreaterThan(0);
  expect(embs.some((e) => e.content.includes("second reason"))).toBe(true);
});
