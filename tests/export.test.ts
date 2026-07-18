import { test, expect } from "vitest";
import { app } from "../src/api/app.js";
import { db } from "../src/db/client.js";
import { tickets, comments, notes } from "../src/db/schema.js";
import { buildBrief } from "../src/services/export.js";
import { startCouncil } from "../src/council/runs.js";
import { randomUUID } from "node:crypto";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { sanitizeFilename } from "../src/api/export-routes.js";

test("export brief ticket", async () => {
  const uniq = "exp-tkt-" + randomUUID().slice(0, 8);
  const { actor } = await createActor({ name: uniq, kind: "human", role: "admin" });
  const project = await createProject({ key: uniq, name: "Export test" });
  const [ticket] = await db.insert(tickets).values({
    projectId: project.id, title: `title ${uniq}`, body: "body test", status: "open", priority: "normal", requiresVerification: false
  }).returning();
  await db.insert(comments).values({
    ticketId: ticket.id, authorId: actor.id, body: "comment sk-test1234567890abcdefgh", kind: "comment"
  });

  const { filename, markdown } = await buildBrief("ticket", ticket.id);
  expect(filename).toBe(`ticket-${ticket.id.slice(0, 8)}.md`);
  expect(markdown).toContain(`title ${uniq}`);
  expect(markdown).toContain(uniq); // author name
  expect(markdown).toContain("comment [redacted]");
  expect(markdown).not.toContain("sk-test1234567890abcdefgh");
});

test("export brief council", async () => {
  const uniq = "exp-cncl-" + randomUUID().slice(0, 8);
  const { actor } = await createActor({ name: uniq, kind: "human", role: "admin" });

  const { councilId } = await startCouncil(actor.id, {} as any, { prompt: `a prompt long enough to pass the check ${uniq}` });

  const { filename, markdown } = await buildBrief("council", councilId);
  expect(filename).toBe(`council-${councilId.slice(0, 8)}.md`);
  expect(markdown).toContain("Council Run");
  expect(markdown).toContain(uniq);
  
  await expect(buildBrief("council", "unknown-id")).rejects.toThrow();
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

  // 404 unknown id (must be uuid-shaped; a non-uuid string 500s at the PG layer)
  const res2 = await app.request(`/export/brief?kind=note&id=${randomUUID()}`, {
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

// Filenames are id-derived today, so no attacker-controlled text reaches the
// header; this pins the defense-in-depth sanitizer itself plus the header shape.
test("export brief filename sanitization (defense-in-depth)", async () => {
  expect(sanitizeFilename(`evil"
name😀.md`)).toBe("evilname.md");
  const uniq = "exp-san-" + randomUUID().slice(0, 8);
  const { actor, apiKey } = await createActor({ name: uniq, kind: "human", role: "member" });
  const [note] = await db.insert(notes).values({
    actorId: actor.id, scope: "global", body: "body", title: "note\"\r\ntitle😀", indexed: false, version: 1
  }).returning();

  const res = await app.request(`/export/brief?kind=note&id=${note.id}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  expect(res.status).toBe(200);
  const disposition = res.headers.get("Content-Disposition") || "";
  // The header legitimately wraps the filename in quotes; judge the VALUE.
  const fname = /filename="([^"]*)"/.exec(disposition)?.[1] ?? "";
  expect(fname.length).toBeGreaterThan(0);
  expect(fname).not.toContain('"');
  expect(disposition).not.toContain('\r');
  expect(disposition).not.toContain('\n');
  expect(disposition).not.toContain('😀');
});
