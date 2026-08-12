import { afterEach, expect, test } from "vitest";
import { like, sql as dsql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { embeddings, notes, projects } from "../src/db/schema.js";
import { createActor } from "../src/services/actors.js";
import { createTicket } from "../src/services/tickets.js";
import { listComments } from "../src/services/comments.js";
import { searchKnowledge } from "../src/services/knowledge.js";
import { FakeEmbedder } from "../src/knowledge/embedder.js";
import {
  parseArtifactBlock,
  formatArtifactBlock,
  confirmObjection,
  preflightDuplicateCheck,
  recordDecision,
  type ArtifactBlock,
} from "../src/services/preflight.js";

const emb = new FakeEmbedder(1024);

// recordDecision indexes a note per call, and every indexed row competes for the
// top-k of every other file's search. Left behind, they pushed knowledge-search's
// two seeded files out of its limit-20 window and failed it on master. Files run
// in parallel against one database, so a file that adds rows has to remove them.
afterEach(async () => {
  // Drop the embeddings, not the notes: events rows reference notes by FK. Marking
  // them indexed stops the sweeper re-embedding what we just removed.
  const stale = db.select({ id: dsql<string>`${notes.id}::text` }).from(notes)
    .where(like(notes.title, "decision %"));
  await db.delete(embeddings).where(dsql`${embeddings.sourceKind} = 'note' AND ${embeddings.sourceRef} IN ${stale}`);
  await db.update(notes).set({ indexed: true }).where(like(notes.title, "decision %"));
});

// Bind searchKnowledge to the fake embedder for test injection
const boundSearch: typeof searchKnowledge = (query, opts) => searchKnowledge(query, opts, emb);

const ZAP: ArtifactBlock = {
  artifact: "zap",
  id: "12345",
  trigger: "airtable.record_created",
  table: "Leads",
  target: "slack.post_message",
  channel: "#sales",
};

async function seed() {
  const { actor } = await createActor({ name: `pf-${Date.now()}-${Math.random()}`, kind: "agent" });
  const [proj] = await db.insert(projects)
    .values({ key: `p-${Date.now()}-${Math.random()}`, name: "P" }).returning();
  const ticket = await createTicket(actor.id, { projectId: proj.id, title: "T" });
  return { actorId: actor.id, projectId: proj.id, ticketId: ticket.id };
}

test("parseArtifactBlock: valid fenced json returns block", () => {
  expect(parseArtifactBlock(formatArtifactBlock(ZAP))?.id).toBe("12345");
});
test("parseArtifactBlock: missing id returns null", () => {
  expect(parseArtifactBlock('```json\n{"artifact":"zap"}\n```')).toBeNull();
});
test("parseArtifactBlock: no fence returns null", () => {
  expect(parseArtifactBlock("no block here")).toBeNull();
});
test("parseArtifactBlock: malformed json returns null", () => {
  expect(parseArtifactBlock("```json\n{not json}\n```")).toBeNull();
});

test("confirmObjection: id+trigger+table exact -> matched", () => {
  expect(confirmObjection(ZAP, ZAP)).toEqual(["trigger", "table", "target", "channel"]);
});
test("confirmObjection: trigger match, table differs, no other resource -> null (counter-case)", () => {
  const req: ArtifactBlock = { artifact: "zap", id: "req", trigger: "airtable.record_created", table: "Contacts" };
  const cand: ArtifactBlock = { artifact: "zap", id: "12345", trigger: "airtable.record_created", table: "Leads" };
  expect(confirmObjection(req, cand)).toBeNull();
});
test("confirmObjection: candidate missing id -> null", () => {
  expect(confirmObjection(ZAP, { ...ZAP, id: "" })).toBeNull();
});
test("confirmObjection: request missing trigger -> null", () => {
  expect(confirmObjection({ ...ZAP, trigger: undefined }, ZAP)).toBeNull();
});

test("preflight fires objection after a matching decision is recorded, writes evidence comment", async () => {
  const ctx = await seed();
  await recordDecision(ZAP, "new", ctx, { emb });
  const res = await preflightDuplicateCheck(ZAP, ctx, { search: boundSearch });
  expect(res.objection).not.toBeNull();
  if (res.objection) {
    expect(res.objection.candidateId).toBe("12345");
    expect(res.objection.body).toContain("12345");
    expect(res.objection.body).toContain("airtable.record_created");
  }
  const comments = await listComments(ctx.ticketId);
  expect(comments.some((c) => c.kind === "evidence" && c.body.includes("12345"))).toBe(true);
});

test("preflight stays silent on near-match (table differs), no evidence comment", async () => {
  const ctx = await seed();
  await recordDecision(ZAP, "new", ctx, { emb });
  const req: ArtifactBlock = { ...ZAP, id: "req", table: "Contacts", target: undefined, channel: undefined };
  const res = await preflightDuplicateCheck(req, ctx, { search: boundSearch });
  expect(res.objection).toBeNull();
  const comments = await listComments(ctx.ticketId);
  expect(comments.some((c) => c.kind === "evidence")).toBe(false);
});

test("recordDecision writes a decision comment and a searchable ticket note", async () => {
  const ctx = await seed();
  const { commentId, noteId } = await recordDecision(ZAP, "extend", ctx, { emb });
  expect(commentId).toBeTruthy();
  expect(noteId).toBeTruthy();
  const comments = await listComments(ctx.ticketId);
  expect(comments.some((c) => c.kind === "decision" && c.body.includes("extend"))).toBe(true);
});

// This test can ONLY pass through pass 1 (exact-match). It injects search returning
// empty array, so semantic fallback finds nothing. If pass 1 is disabled, this fails.
test("preflight fires objection via exact-match pass when semantic search returns nothing", async () => {
  const ctx = await seed();
  await recordDecision(ZAP, "new", ctx, { emb });
  // Inject search that always returns empty — semantic path finds nothing
  const emptySearch: typeof searchKnowledge = async () => [];
  const res = await preflightDuplicateCheck(ZAP, ctx, { search: emptySearch });
  expect(res.objection).not.toBeNull();
  if (res.objection) {
    expect(res.objection.candidateId).toBe("12345");
    expect(res.objection.body).toContain("12345");
    expect(res.objection.body).toContain("airtable.record_created");
  }
  const comments = await listComments(ctx.ticketId);
  expect(comments.some((c) => c.kind === "evidence" && c.body.includes("12345"))).toBe(true);
});
