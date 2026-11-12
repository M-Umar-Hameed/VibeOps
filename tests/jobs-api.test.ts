process.env.EMBED_PROVIDER = "fake";

import { expect, test, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { app } from "../src/api/app.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { startSessionIngestJob } from "../src/ingest/sessions/ingest.js";
import { FakeEmbedder } from "../src/knowledge/embedder.js";
import type { SessionSource } from "../src/ingest/sessions/source.js";
import { db } from "../src/db/client.js";
import { projects } from "../src/db/schema.js";

test("GET /jobs requires auth and 404 for unknown job", async () => {
  const unauth = await app.request("/jobs", { method: "GET" });
  expect(unauth.status).toBe(401);

  const { apiKey } = await createActor({ name: `job-admin-${Date.now()}`, kind: "human", role: "admin" });
  const h = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  const notFound = await app.request("/jobs/00000000-0000-0000-0000-000000000000", { method: "GET", headers: h });
  expect(notFound.status).toBe(404);
});

test("async sessions: POST /ingest/sessions?async=1 returns 202 and completes", async () => {
  const { apiKey } = await createActor({ name: `job-admin-${Date.now()}`, kind: "human", role: "admin" });
  const h = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  const res = await app.request("/ingest/sessions?async=1", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ sinceDays: 0 }),
  });
  expect(res.status).toBe(202);
  const { jobId } = await res.json();
  expect(jobId).toBeDefined();

  let finalJob: any;
  await vi.waitFor(async () => {
    const poll = await app.request(`/jobs/${jobId}`, { method: "GET", headers: h });
    expect(poll.status).toBe(200);
    const j = await poll.json();
    expect(j.state).toBe("done");
    finalJob = j;
  }, { timeout: 30000 });

  for (const source of ["claude-mem", "claude-code", "codex", "antigravity"]) {
    expect(finalJob.result[source]).toBeDefined();
  }
});

test("dedupe and cancel: running job returns existing jobId and can be cancelled", async () => {
  const { apiKey } = await createActor({ name: `job-admin-${Date.now()}`, kind: "human", role: "admin" });
  const h = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  let releaseGate!: () => void;
  const gate = new Promise<void>((r) => { releaseGate = r; });
  const gatedSource: SessionSource = {
    source: "gated",
    listSessionDocs: async () => {
      await gate;
      return [];
    },
  };

  const started = startSessionIngestJob([gatedSource], new FakeEmbedder(1024), 1);
  const sameId = started.job.id;

  try {
    const asyncPost = await app.request("/ingest/sessions?async=1", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ sinceDays: 1 }),
    });
    expect(asyncPost.status).toBe(202);
    const asyncBody = await asyncPost.json();
    expect(asyncBody).toEqual({ jobId: sameId, existing: true });

    const syncPost = await app.request("/ingest/sessions", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ sinceDays: 1 }),
    });
    expect(syncPost.status).toBe(409);
    const syncBody = await syncPost.json();
    expect(syncBody.jobId).toBe(sameId);

    const activeRes = await app.request("/jobs?active=1", { method: "GET", headers: h });
    expect(activeRes.status).toBe(200);
    const activeList = await activeRes.json();
    expect(activeList.some((j: any) => j.id === sameId && j.label === "Sync sessions")).toBe(true);

    const cancelRes = await app.request(`/jobs/${sameId}/cancel`, { method: "POST", headers: h });
    expect(cancelRes.status).toBe(200);

    releaseGate();

    await vi.waitFor(async () => {
      const poll = await app.request(`/jobs/${sameId}`, { method: "GET", headers: h });
      const j = await poll.json();
      expect(j.state).toBe("cancelled");
    }, { timeout: 30000 });
  } finally {
    releaseGate();
  }
});

test("index-repo: async 202 followed by sync 200 with X-Job-Id header", async () => {
  const { apiKey } = await createActor({ name: `job-admin-${Date.now()}`, kind: "human", role: "admin" });
  const h = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  const root = mkdtempSync(join(tmpdir(), "repo-index-job-"));
  try {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(root, `doc-${i}.md`), `# Doc ${i}\ncontent ${i}`);
    }
    const p = await createProject({ key: `rij-${Date.now()}-${Math.random().toString(36).slice(2)}`, name: "RI Job" });
    await db.update(projects).set({ repoPath: root }).where(eq(projects.id, p.id));

    const asyncRes = await app.request(`/projects/${p.id}/index-repo?async=1`, { method: "POST", headers: h });
    expect(asyncRes.status).toBe(202);
    const { jobId } = await asyncRes.json();

    let jobData: any;
    await vi.waitFor(async () => {
      const poll = await app.request(`/jobs/${jobId}`, { method: "GET", headers: h });
      const j = await poll.json();
      expect(j.state).toBe("done");
      jobData = j;
    }, { timeout: 30000 });

    expect(jobData.done).toBe(5);
    expect(jobData.total).toBe(5);
    expect(jobData.result.indexed).toBe(5);

    const syncRes = await app.request(`/projects/${p.id}/index-repo`, { method: "POST", headers: h });
    expect(syncRes.status).toBe(200);
    expect(syncRes.headers.get("X-Job-Id")).toBeTruthy();
    const syncBody = await syncRes.json();
    expect(syncBody).toEqual({ indexed: 5, skipped: 0, removed: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear knowledge: DELETE /projects/:id/knowledge returns 200 with removed count", async () => {
  const { apiKey } = await createActor({ name: `job-admin-${Date.now()}`, kind: "human", role: "admin" });
  const h = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  const p = await createProject({ key: `clr-${Date.now()}-${Math.random().toString(36).slice(2)}`, name: "Clear Proj" });

  const res = await app.request(`/projects/${p.id}/knowledge`, { method: "DELETE", headers: h });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ removed: expect.any(Number) });
});
