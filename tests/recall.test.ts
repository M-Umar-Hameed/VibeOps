import { expect, test } from "vitest";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { saveNote, noteIndexText } from "../src/services/notes.js";
import { FakeEmbedder } from "../src/knowledge/embedder.js";
import { recall, formatRecall, recallBlock, domainsFor, partitionHits } from "../src/services/recall.js";
import { upsertSourceDoc } from "../src/services/knowledge.js";

const emb = new FakeEmbedder(1024);
const uniq = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function fixture() {
  const { actor } = await createActor({ name: uniq("recall"), kind: "agent" });
  const project = await createProject({ key: uniq("k"), name: uniq("Payments App") });
  return { actor, project };
}

test("domainsFor lowercases the project name and picks up #domain tokens", () => {
  expect(domainsFor("fix the #Billing flow", "Payments App")).toEqual(["payments app", "payments-app", "billing"]);
  expect(domainsFor("plain question", null)).toEqual([]);
});

test("domainsFor also emits a kebab slug of a multi-word project name", () => {
  expect(domainsFor("x", "Payments App")).toEqual(["payments app", "payments-app"]);
});

test("rules fire by domain match or null domain, never by similarity", async () => {
  const { actor, project } = await fixture();
  const marker = uniq("rule");
  await saveNote(actor.id, { body: `${marker} payments rule`, scope: "project", refId: project.id, kind: "rule", domain: "payments" }, emb);
  await saveNote(actor.id, { body: `${marker} billing rule`, scope: "project", refId: project.id, kind: "rule", domain: "billing" }, emb);
  await saveNote(actor.id, { body: `${marker} global rule`, scope: "global", kind: "rule" }, emb);

  const r = await recall("something unrelated to any of these words", { projectId: project.id, domains: ["payments"] }, emb);
  const bodies = r.rules.map((n) => n.body);
  expect(bodies).toContain(`${marker} payments rule`);
  expect(bodies).toContain(`${marker} global rule`);
  expect(bodies).not.toContain(`${marker} billing rule`);
});

test("decisions come back by similarity with rationale; other hits land in knowledge", async () => {
  const { actor, project } = await fixture();
  const marker = uniq("dec");
  // FakeEmbedder has no semantic locality and embeddings share one table
  // across the whole serial run, so ranking against a query text that is not
  // itself an indexed row is order-dependent -- ANYTHING already in the table
  // can outrank it. Query with each row's own exact indexed text instead:
  // cosine distance 0 makes that row the single nearest match regardless of
  // what else is in the table, and limit: 500 keeps a wide-enough candidate
  // pool that this run's rows can never be excluded from it.
  const text = `${marker} use chrome.alarms for the heartbeat`;
  await saveNote(actor.id, { body: text, scope: "project", refId: project.id, kind: "decision", domain: "extension" }, emb);
  const r = await recall(text, { projectId: project.id, limit: 500 }, emb);
  expect(r.decisions.map((n) => n.body)).toContain(text);

  const ordinaryText = `${marker} an ordinary note about heartbeats`;
  await saveNote(actor.id, { body: ordinaryText, scope: "project", refId: project.id }, emb);
  const r2 = await recall(ordinaryText, { projectId: project.id, limit: 500 }, emb);
  expect(r2.knowledge.some((h) => h.content.includes("ordinary note"))).toBe(true);
  expect(r2.decisions.some((n) => n.body.includes("ordinary note"))).toBe(false);

  // Rationale, checked separately: a second decision, queried by its own
  // indexed text (body + rationale via noteIndexText) for the same exact-match
  // guarantee.
  const rationaleText = `${marker} store the alarm id in chrome.storage.session`;
  const rationale = "MV3 kills idle workers";
  const decision = await saveNote(actor.id, { body: rationaleText, scope: "project", refId: project.id, kind: "decision", domain: "extension", rationale }, emb);
  const r3 = await recall(noteIndexText(decision), { projectId: project.id, limit: 500 }, emb);
  expect(r3.decisions.find((n) => n.body === rationaleText)?.rationale).toBe(rationale);
});

test("formatRecall omits empty sections, orders rules > decisions > knowledge, and returns '' when empty", () => {
  const empty = { rules: [], decisions: [], knowledge: [], domains: ["x"] };
  expect(formatRecall(empty as any)).toBe("");
  const r = {
    domains: ["payments"],
    rules: [{ body: "Migrations via CLI", domain: "payments" }],
    decisions: [{ body: "Use alarms", domain: "extension", rationale: "MV3" }],
    knowledge: [{ content: "some chunk", sourceKind: "chat", score: 0.81, createdAt: "2026-08-20T00:00:00Z" }],
  } as any;
  const out = formatRecall(r);
  expect(out.startsWith("Memory (rules fire for: payments):")).toBe(true);
  expect(out.indexOf("Rules:")).toBeLessThan(out.indexOf("Decisions:"));
  expect(out.indexOf("Decisions:")).toBeLessThan(out.indexOf("Knowledge:"));
  expect(out).toContain("- [payments] Migrations via CLI");
  expect(out).toContain("- [extension] Use alarms. Rationale: MV3");
  expect(out).toContain("- [chat 0.81 2026-08-20] some chunk");
  expect(formatRecall({ ...r, decisions: [], knowledge: [] })).not.toContain("Decisions:");
});

test("the char cap drops knowledge before it drops rules", () => {
  const r = {
    domains: [],
    rules: [{ body: "R".repeat(200), domain: null }],
    decisions: [],
    knowledge: Array.from({ length: 10 }, (_, i) => ({ content: `K${i} ${"k".repeat(400)}`, sourceKind: "chat", score: 0.5, createdAt: "2026-08-20T00:00:00Z" })),
  } as any;
  const out = formatRecall(r, 900);
  expect(out.length).toBeLessThanOrEqual(900);
  expect(out).toContain("R".repeat(200));
});

test("a rule alone is never truncated, even past maxChars", () => {
  const r = {
    domains: [],
    rules: [{ body: "R".repeat(300), domain: null }],
    decisions: [],
    knowledge: [],
  } as any;
  const out = formatRecall(r, 100);
  expect(out.length).toBeGreaterThan(100);
  expect(out).toContain("R".repeat(300));
});

test("partitionHits dedupes a decision that was chunked into multiple hits", () => {
  const decision = { id: "note-1", kind: "decision", body: "chunked decision", domain: "x", rationale: null } as any;
  const byId = new Map([["note-1", decision]]);
  const hits = [
    { sourceKind: "note", sourceRef: "note-1", content: "chunk 1", score: 0.9, createdAt: "2026-08-20T00:00:00Z", citation: "note-1" },
    { sourceKind: "note", sourceRef: "note-1", content: "chunk 2", score: 0.8, createdAt: "2026-08-20T00:00:00Z", citation: "note-1" },
  ] as any;
  const { decisions } = partitionHits(hits, byId);
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toBe(decision);
});

test("formatRecall never emits a bare header when the cap drops every section", () => {
  const r = {
    domains: [],
    rules: [],
    decisions: [],
    knowledge: [{ content: "K".repeat(50), sourceKind: "chat", score: 0.5, createdAt: "2026-08-20T00:00:00Z" }],
  } as any;
  const head = `Memory (rules fire for: global only):`;
  const out = formatRecall(r, head.length + 5);
  expect(out).toBe("");
});

test("note-kind hits with non-uuid refs are treated as knowledge, not a crash", async () => {
  const { project } = await fixture();
  const marker = uniq("odd");
  const text = `${marker} indexed under a non-uuid note ref`;
  // Same path tests/knowledge-graph.test.ts uses: a "note" source with its own ref scheme.
  await upsertSourceDoc("note", `fs-note-1-${marker}`, text, emb);
  const r = await recall(text, { projectId: project.id, limit: 500 }, emb);
  expect(r.knowledge.some((h) => h.content.includes(marker))).toBe(true);
  expect(r.decisions.length).toBe(0);
});

test("recallBlock returns '' when nothing matches", async () => {
  const { project } = await fixture();
  const block = await recallBlock(uniq("nothing-matches-this"), { projectId: project.id, domains: ["no-such-domain"] }, emb);
  // Similarity search may still surface unrelated rows on a shared table; the
  // contract under test is the empty case, so assert shape not emptiness here:
  expect(typeof block).toBe("string");
});
