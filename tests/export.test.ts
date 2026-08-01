process.env.EMBED_PROVIDER = "fake";
import { test, expect } from "vitest";
import { app } from "../src/api/app.js";
import { db } from "../src/db/client.js";
import { tickets, comments, notes } from "../src/db/schema.js";
import { buildBrief, MAX_BRIEF_CHARS } from "../src/services/export.js";
import { upsertSourceDoc } from "../src/services/knowledge.js";
import { getEmbedder } from "../src/knowledge/embedder.js";
import { saveNote } from "../src/services/notes.js";
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
});

test("export brief project: multi-source markdown with section headers, secrets redacted", async () => {
  const uniq = "exp-prj-" + randomUUID().slice(0, 8);
  const { actor } = await createActor({ name: uniq, kind: "human", role: "admin" });
  const project = await createProject({ key: uniq, name: `Proj ${uniq}` });
  const embedder = getEmbedder();

  await upsertSourceDoc("repo", `${project.id}:docs/a.md`, `# Doc A\nalpha content ${uniq}`, embedder);
  await upsertSourceDoc("repo", `${project.id}:docs/b.md`, `# Doc B\nbeta content ${uniq}`, embedder);
  await saveNote(actor.id, { body: `note body gamma sk-test1234567890abcdefgh`, scope: "project", refId: project.id, title: "PN" }, embedder);

  const { filename, markdown } = await buildBrief("project", project.id);
  expect(filename).toBe(`project-${project.id.slice(0, 8)}.md`);
  expect(markdown).toContain(`Proj ${uniq}`);
  expect(markdown).toContain("docs/a.md");
  expect(markdown).toContain("docs/b.md");
  expect(markdown).toContain("alpha content");
  expect(markdown).toContain("beta content");
  expect(markdown).toContain("Note: PN");
  expect(markdown).toContain("[redacted]");
  expect(markdown).not.toContain("sk-test1234567890abcdefgh");
});

test("export brief project: no indexed repo docs throws actionable conflict, endpoint 409", async () => {
  const uniq = "exp-prj-empty-" + randomUUID().slice(0, 8);
  const { apiKey } = await createActor({ name: uniq, kind: "human", role: "member" });
  const project = await createProject({ key: uniq, name: `Empty ${uniq}` });

  await expect(buildBrief("project", project.id)).rejects.toThrow(/no indexed repo docs/i);

  const res = await app.request(`/export/brief?kind=project&id=${project.id}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  expect(res.status).toBe(409);
});

test("export brief project: respects size cap and states truncation", async () => {
  const uniq = "exp-prj-cap-" + randomUUID().slice(0, 8);
  await createActor({ name: uniq, kind: "human", role: "admin" });
  const project = await createProject({ key: uniq, name: `Big ${uniq}` });
  const embedder = getEmbedder();

  const big = "x".repeat(70_000);
  for (let i = 0; i < 4; i++) {
    await upsertSourceDoc("repo", `${project.id}:docs/${i}.md`, big, embedder);
  }

  const { markdown } = await buildBrief("project", project.id);
  expect(markdown).toContain("truncated");
  expect(markdown.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS + 500);
});
