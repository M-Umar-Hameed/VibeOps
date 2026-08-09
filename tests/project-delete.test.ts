import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBootstrap } from "../src/bootstrap.js";
import { eq, inArray, like } from "drizzle-orm";

import { db } from "../src/db/client.js";
import {
  projects, projectSettings, tickets, comments, events, notes,
  syncLinks, syncCommentLinks, forgeRuns, aiUsageLogs, embeddings,
} from "../src/db/schema.js";
import { createActor } from "../src/services/actors.js";
import { createProject, updateProjectRepo, deleteProject, setProjectSetting } from "../src/services/projects.js";
import { createTicket } from "../src/services/tickets.js";
import { addComment } from "../src/services/comments.js";
import { saveNote } from "../src/services/notes.js";
import { upsertSourceDoc, clearProjectKnowledge } from "../src/services/knowledge.js";
import { FakeEmbedder } from "../src/knowledge/embedder.js";
import { app } from "../src/api/app.js";
import * as knowledgeSvc from "../src/services/knowledge.js";
import * as runsSvc from "../src/forge/runs.js";

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function adminHeaders(): Promise<Record<string, string>> {
  const { apiKey } = await createActor({ name: uniq("pd-admin"), kind: "human", role: "admin" });
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

const emb = new FakeEmbedder(1024);

// Seed a project with every dependent type for comprehensive delete tests.
async function seedFullProject(actorId: string) {
  const p = await createProject({ key: uniq("pd"), name: uniq("Project") });
  const repoDir = mkdtempSync(join(tmpdir(), "pd-repo-"));
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  await updateProjectRepo(p.id, repoDir);

  const vaultDir = mkdtempSync(join(tmpdir(), "pd-vault-"));
  await setProjectSetting(p.id, "vault.path", vaultDir);

  const t = await createTicket(actorId, { projectId: p.id, title: uniq("ticket") });
  const c = await addComment(actorId, t.id, "comment body", "comment");

  // forge_runs row (ticketId no FK)
  await db.insert(forgeRuns).values({
    id: randomUUID(), ticketId: t.id, status: "passed", stage: "review",
    planAgent: "a", workAgent: "b", reviewAgent: "c", startedAt: new Date(),
  });

  // ai_usage_logs row (ticketId nullable, no FK)
  await db.insert(aiUsageLogs).values({
    provider: "test", model: "test", tokens: 100, ticketId: t.id,
  });

  // sync_links + sync_comment_links
  const [sl] = await db.insert(syncLinks).values({
    source: "test", externalId: uniq("ext"), ticketId: t.id,
  }).returning();
  await db.insert(syncCommentLinks).values({
    source: "test", externalId: uniq("cext"), commentId: c.id,
  });

  // notes (project-scope and ticket-scope)
  const pn = await saveNote(actorId, { body: "project note", scope: "project", refId: p.id });
  const tn = await saveNote(actorId, { body: "ticket note", scope: "ticket", refId: t.id });

  // embeddings: repo, vault, note
  await upsertSourceDoc("repo", `${p.id}:README.md`, "repo doc content", emb);
  await upsertSourceDoc("vault", `${p.id}:vault.md`, "vault doc content", emb);
  await upsertSourceDoc("note", pn.id, "project note embed", emb);
  await upsertSourceDoc("note", tn.id, "ticket note embed", emb);

  return { project: p, ticket: t, comment: c, projectNote: pn, ticketNote: tn, repoDir, vaultDir, syncLink: sl };
}

describe("clear project knowledge", () => {
  it("removes project chunks, keeps rows + globals", async () => {
    const h = await adminHeaders();
    const { actor: a } = await createActor({ name: uniq("clr-a"), kind: "human", role: "admin" });

    // control: session + global-vault + another project
    const sessionRef = `session-${uniq("s")}`;
    await upsertSourceDoc("session", sessionRef, "session content", emb);
    const globalVaultRef = `C:/global/vault/file-${uniq("g")}.md`;
    await upsertSourceDoc("vault", globalVaultRef, "global vault content", emb);

    const pB = await createProject({ key: uniq("ctrlB"), name: "Control B" });
    const bRef = `${pB.id}:ctrl.md`;
    await upsertSourceDoc("repo", bRef, "other project repo", emb);

    // target project
    const { project: pA, ticket, projectNote, ticketNote, repoDir, vaultDir } = await seedFullProject(a.id);

    const res = await app.request(`/projects/${pA.id}/knowledge`, { method: "DELETE", headers: h });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.removed).toBeGreaterThan(0);

    // Assert A's chunks gone
    const aRepoRows = await db.select().from(embeddings).where(like(embeddings.sourceRef, `${pA.id}:%`));
    expect(aRepoRows).toHaveLength(0);
    const aProjectNoteRows = await db.select().from(embeddings).where(eq(embeddings.sourceRef, projectNote.id));
    expect(aProjectNoteRows).toHaveLength(0);
    const aTicketNoteRows = await db.select().from(embeddings).where(eq(embeddings.sourceRef, ticketNote.id));
    expect(aTicketNoteRows).toHaveLength(0);

    // Assert rows stay
    expect((await db.select().from(tickets).where(eq(tickets.id, ticket.id))).length).toBe(1);
    expect((await db.select().from(notes).where(eq(notes.id, projectNote.id))).length).toBe(1);
    expect((await db.select().from(notes).where(eq(notes.id, ticketNote.id))).length).toBe(1);
    const eventsForTicket = await db.select().from(events).where(eq(events.ticketId, ticket.id));
    expect(eventsForTicket.length).toBeGreaterThanOrEqual(1);

    // Assert control globals remain
    const sessionRows = await db.select().from(embeddings).where(eq(embeddings.sourceRef, sessionRef));
    expect(sessionRows.length).toBeGreaterThan(0);
    const globalVaultRows = await db.select().from(embeddings).where(eq(embeddings.sourceRef, globalVaultRef));
    expect(globalVaultRows.length).toBeGreaterThan(0);
    const bRows = await db.select().from(embeddings).where(eq(embeddings.sourceRef, bRef));
    expect(bRows.length).toBeGreaterThan(0);

    rmSync(repoDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
  });
});

describe("delete project", () => {
  it("clears every audited table — asserts per table", async () => {
    const h = await adminHeaders();
    const { actor: a } = await createActor({ name: uniq("del-a"), kind: "human", role: "admin" });

    // Control project
    const { actor: actorB } = await createActor({ name: uniq("del-b"), kind: "human", role: "admin" });
    const pB = await createProject({ key: uniq("ctrlB2"), name: "Control B2" });
    const tB = await createTicket(actorB.id, { projectId: pB.id, title: "ctrl ticket" });
    const cB = await addComment(actorB.id, tB.id, "ctrl comment", "comment");
    const nB = await saveNote(actorB.id, { body: "ctrl note", scope: "project", refId: pB.id });
    await upsertSourceDoc("repo", `${pB.id}:ctrl.md`, "ctrl repo", emb);

    // Target project
    const {
      project: pA, ticket: tA, comment: cA, projectNote: pnA, ticketNote: tnA, repoDir, vaultDir,
    } = await seedFullProject(a.id);

    const res = await app.request(`/projects/${pA.id}`, { method: "DELETE", headers: h });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });

    // Assert per table for A
    expect((await db.select().from(projects).where(eq(projects.id, pA.id))).length).toBe(0);
    expect((await db.select().from(projectSettings).where(eq(projectSettings.projectId, pA.id))).length).toBe(0);
    expect((await db.select().from(tickets).where(eq(tickets.id, tA.id))).length).toBe(0);
    expect((await db.select().from(comments).where(eq(comments.id, cA.id))).length).toBe(0);
    expect((await db.select().from(events).where(eq(events.ticketId, tA.id))).length).toBe(0);
    expect((await db.select().from(events).where(eq(events.noteId, pnA.id))).length).toBe(0);
    expect((await db.select().from(syncLinks).where(eq(syncLinks.ticketId, tA.id))).length).toBe(0);
    const commentIds = [cA.id];
    expect((await db.select().from(syncCommentLinks).where(inArray(syncCommentLinks.commentId, commentIds))).length).toBe(0);
    expect((await db.select().from(forgeRuns).where(eq(forgeRuns.ticketId, tA.id))).length).toBe(0);
    expect((await db.select().from(aiUsageLogs).where(eq(aiUsageLogs.ticketId, tA.id))).length).toBe(0);
    expect((await db.select().from(notes).where(eq(notes.id, pnA.id))).length).toBe(0);
    expect((await db.select().from(notes).where(eq(notes.id, tnA.id))).length).toBe(0);
    expect((await db.select().from(embeddings).where(like(embeddings.sourceRef, `${pA.id}:%`))).length).toBe(0);

    // Assert control B untouched
    expect((await db.select().from(projects).where(eq(projects.id, pB.id))).length).toBe(1);
    expect((await db.select().from(tickets).where(eq(tickets.id, tB.id))).length).toBe(1);
    expect((await db.select().from(comments).where(eq(comments.id, cB.id))).length).toBe(1);
    expect((await db.select().from(notes).where(eq(notes.id, nB.id))).length).toBe(1);
    expect((await db.select().from(embeddings).where(like(embeddings.sourceRef, `${pB.id}:%`))).length).toBeGreaterThan(0);

    rmSync(repoDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it("transaction rollback on mid-failure — nothing removed", async () => {
    const { actor: a } = await createActor({ name: uniq("rb-a"), kind: "human", role: "admin" });
    const { project: p, ticket: t, comment: c, projectNote: pn, repoDir, vaultDir } = await seedFullProject(a.id);

    // Inject failure in clearProjectKnowledge mid-transaction
    const spy = vi.spyOn(knowledgeSvc, "clearProjectKnowledge").mockRejectedValueOnce(new Error("boom"));

    await expect(deleteProject(p.id)).rejects.toThrow("boom");
    spy.mockRestore();

    // All rows still present
    expect((await db.select().from(projects).where(eq(projects.id, p.id))).length).toBe(1);
    expect((await db.select().from(tickets).where(eq(tickets.id, t.id))).length).toBe(1);
    expect((await db.select().from(comments).where(eq(comments.id, c.id))).length).toBe(1);
    expect((await db.select().from(events).where(eq(events.ticketId, t.id))).length).toBeGreaterThanOrEqual(1);
    expect((await db.select().from(forgeRuns).where(eq(forgeRuns.ticketId, t.id))).length).toBe(1);
    expect((await db.select().from(aiUsageLogs).where(eq(aiUsageLogs.ticketId, t.id))).length).toBe(1);
    expect((await db.select().from(notes).where(eq(notes.id, pn.id))).length).toBe(1);
    expect((await db.select().from(embeddings).where(like(embeddings.sourceRef, `${p.id}:%`))).length).toBeGreaterThan(0);

    rmSync(repoDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it("409 when active forge run exists", async () => {
    const h = await adminHeaders();
    const { actor: a } = await createActor({ name: uniq("ar-a"), kind: "human", role: "admin" });
    const { project: p, repoDir, vaultDir } = await seedFullProject(a.id);

    const spy = vi.spyOn(runsSvc, "activeRunForProject").mockResolvedValueOnce("run-123");
    const res = await app.request(`/projects/${p.id}`, { method: "DELETE", headers: h });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.runId).toBe("run-123");
    spy.mockRestore();

    // Project still exists
    expect((await db.select().from(projects).where(eq(projects.id, p.id))).length).toBe(1);

    rmSync(repoDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it("existing Inbox survives upgrade and is deletable like any other project", async () => {
    const h = await adminHeaders();
    // Simulate an install that already has an Inbox (unique key to stay isolated
    // from any bootstrapped inbox in the shared test DB).
    const key = uniq("inbox");
    const inbox = await createProject({ key, name: "Inbox" });

    // Upgrade is a re-boot; runBootstrap early-returns when actors exist, so it
    // never deletes anything.
    await runBootstrap(8787, mkdtempSync(join(tmpdir(), "pd-boot-")));
    expect((await db.select().from(projects).where(eq(projects.id, inbox.id))).length).toBe(1);

    // No special-case guard: owner can delete it.
    const res = await app.request(`/projects/${inbox.id}`, { method: "DELETE", headers: h });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await db.select().from(projects).where(eq(projects.id, inbox.id))).length).toBe(0);
  });

  it("filesystem untouched after delete", async () => {
    const h = await adminHeaders();
    const { actor: a } = await createActor({ name: uniq("fs-a"), kind: "human", role: "admin" });
    const { project: p, repoDir, vaultDir } = await seedFullProject(a.id);

    expect(existsSync(repoDir)).toBe(true);
    expect(existsSync(vaultDir)).toBe(true);

    const res = await app.request(`/projects/${p.id}`, { method: "DELETE", headers: h });
    expect(res.status).toBe(200);

    // Dirs still exist on disk
    expect(existsSync(repoDir)).toBe(true);
    expect(existsSync(vaultDir)).toBe(true);

    rmSync(repoDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
  });
});
