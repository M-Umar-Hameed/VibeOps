import { expect, test } from "vitest";
import { db } from "../src/db/client.js";
import { projects } from "../src/db/schema.js";
import { createActor } from "../src/services/actors.js";
import { createTicket } from "../src/services/tickets.js";
import { listComments } from "../src/services/comments.js";
import {
  parseArtifactBlock,
  formatArtifactBlock,
  confirmObjection,
  preflightDuplicateCheck,
  recordDecision,
  type ArtifactBlock,
} from "../src/services/preflight.js";

process.env.EMBED_PROVIDER = "fake";

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
  await recordDecision(ZAP, "new", ctx);
  const res = await preflightDuplicateCheck(ZAP, ctx);
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
  await recordDecision(ZAP, "new", ctx);
  const req: ArtifactBlock = { ...ZAP, id: "req", table: "Contacts", target: undefined, channel: undefined };
  const res = await preflightDuplicateCheck(req, ctx);
  expect(res.objection).toBeNull();
  const comments = await listComments(ctx.ticketId);
  expect(comments.some((c) => c.kind === "evidence")).toBe(false);
});

test("recordDecision writes a decision comment and a searchable ticket note", async () => {
  const ctx = await seed();
  const { commentId, noteId } = await recordDecision(ZAP, "extend", ctx);
  expect(commentId).toBeTruthy();
  expect(noteId).toBeTruthy();
  const comments = await listComments(ctx.ticketId);
  expect(comments.some((c) => c.kind === "decision" && c.body.includes("extend"))).toBe(true);
});
