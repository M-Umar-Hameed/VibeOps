import { test, expect } from "vitest";
import { app } from "../src/api/app.js";
import { db } from "../src/db/client.js";
import { tickets, comments, notes } from "../src/db/schema.js";
import { buildBrief } from "../src/services/export.js";
import { randomUUID } from "node:crypto";
import { createActor } from "../src/services/actors.js";

test("export brief ticket", async () => {
  const uniq = "exp-tkt-" + randomUUID().slice(0, 8);
  const { actor } = await createActor({ name: uniq, kind: "human", role: "admin" });
  const [ticket] = await db.insert(tickets).values({
    projectId: "inbox", title: `title ${uniq}`, body: "body test", status: "open", priority: "normal", requiresVerification: false
  }).returning();
  await db.insert(comments).values({
    ticketId: ticket.id, authorId: actor.id, body: "comment sk-test123456789", kind: "comment"
  });

  const { filename, markdown } = await buildBrief("ticket", ticket.id);
  expect(filename).toBe(`ticket-${ticket.id.slice(0, 8)}.md`);
  expect(markdown).toContain(`title ${uniq}`);
  expect(markdown).toContain(uniq); // author name
  expect(markdown).toContain("comment [REDACTED]");
  expect(markdown).not.toContain("sk-test123456789");
});

test("export brief routes", async () => {
  const uniq = "exp-rt-" + randomUUID().slice(0, 8);
  const { actor, apiKey } = await createActor({ name: uniq, kind: "human", role: "member" });
  const [note] = await db.insert(notes).values({
    actorId: actor.id, scope: "global", body: `body ${uniq}`, title: "note title", indexed: false, version: 1
  }).returning();

  // 401 unauthenticated
  const res1 = await app.request(`/export/brief?kind=note&id=${note.id}`);
  expect(res1.status).toBe(401);

  // 404 unknown id
  const res2 = await app.request(`/export/brief?kind=note&id=unknown`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  expect(res2.status).toBe(404);

  // 200 + text/markdown
  const res3 = await app.request(`/export/brief?kind=note&id=${note.id}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  expect(res3.status).toBe(200);
  expect(res3.headers.get("Content-Type")).toContain("text/markdown");
  const text = await res3.text();
  expect(text).toContain(`body ${uniq}`);
});
