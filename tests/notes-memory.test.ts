import { expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { notes } from "../src/db/schema.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { saveNote, noteIndexText } from "../src/services/notes.js";
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
