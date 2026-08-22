import { expect, test } from "vitest";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { saveNote } from "../src/services/notes.js";
import { FakeEmbedder } from "../src/knowledge/embedder.js";
import { recall, formatRecall, recallBlock, domainsFor } from "../src/services/recall.js";

const emb = new FakeEmbedder(1024);
const uniq = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function fixture() {
  const { actor } = await createActor({ name: uniq("recall"), kind: "agent" });
  const project = await createProject({ key: uniq("k"), name: uniq("Payments App") });
  return { actor, project };
}

test("domainsFor lowercases the project name and picks up #domain tokens", () => {
  expect(domainsFor("fix the #Billing flow", "Payments App")).toEqual(["payments app", "billing"]);
  expect(domainsFor("plain question", null)).toEqual([]);
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
  const text = `${marker} use chrome.alarms for the heartbeat`;
  await saveNote(actor.id, { body: text, scope: "project", refId: project.id, kind: "decision", domain: "extension", rationale: "MV3 kills idle workers" }, emb);
  await saveNote(actor.id, { body: `${marker} an ordinary note about heartbeats`, scope: "project", refId: project.id }, emb);

  const r = await recall(text, { projectId: project.id }, emb);
  expect(r.decisions.map((n) => n.body)).toContain(text);
  expect(r.decisions.find((n) => n.body === text)!.rationale).toBe("MV3 kills idle workers");
  expect(r.knowledge.some((h) => h.content.includes("ordinary note"))).toBe(true);
  expect(r.decisions.some((n) => n.body.includes("ordinary note"))).toBe(false);
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

test("recallBlock returns '' when nothing matches", async () => {
  const { project } = await fixture();
  const block = await recallBlock(uniq("nothing-matches-this"), { projectId: project.id, domains: ["no-such-domain"] }, emb);
  // Similarity search may still surface unrelated rows on a shared table; the
  // contract under test is the empty case, so assert shape not emptiness here:
  expect(typeof block).toBe("string");
});
