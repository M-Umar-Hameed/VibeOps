import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { app } from "../src/api/app.js";

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function adminHeaders(): Promise<Record<string, string>> {
  const { apiKey } = await createActor({ name: uniq("pw-admin"), kind: "human", role: "admin" });
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "pw-dir-"));
}

describe("project workspaces", () => {
  it("PATCH /projects/:id rejects non-absolute and missing paths with 400", async () => {
    const h = await adminHeaders();
    const project = await createProject({ key: uniq("pw-proj"), name: "PW" });

    const relRes = await app.request(`/projects/${project.id}`, {
      method: "PATCH", headers: h, body: JSON.stringify({ repoPath: "relative/path" }),
    });
    expect(relRes.status).toBe(400);

    const missingRes = await app.request(`/projects/${project.id}`, {
      method: "PATCH", headers: h,
      body: JSON.stringify({ repoPath: join(tmpdir(), "pw-does-not-exist-xyz") }),
    });
    expect(missingRes.status).toBe(400);
  });

  it("PATCH /projects/:id rejects paths with .. segments with 400", async () => {
    const h = await adminHeaders();
    const project = await createProject({ key: uniq("pw-proj-dots"), name: "PW" });

    const winRes = await app.request(`/projects/${project.id}`, {
      method: "PATCH", headers: h, body: JSON.stringify({ repoPath: "C:\\real\\path\\..\\..\\Windows" }),
    });
    expect(winRes.status).toBe(400);

    const posixRes = await app.request(`/projects/${project.id}`, {
      method: "PATCH", headers: h, body: JSON.stringify({ repoPath: "/real/path/../../etc" }),
    });
    expect(posixRes.status).toBe(400);
  });

  it("PATCH sets repoPath, reports isGit, and clears back to null", async () => {
    const h = await adminHeaders();
    const project = await createProject({ key: uniq("pw-proj"), name: "PW" });
    const dir = tmpDir();

    const setRes = await app.request(`/projects/${project.id}`, {
      method: "PATCH", headers: h, body: JSON.stringify({ repoPath: dir }),
    });
    expect(setRes.status).toBe(200);
    const set = await setRes.json();
    expect(set.repoPath).toBe(dir);
    expect(set.isGit).toBe(false);

    const listRes = await app.request("/projects", { headers: h });
    const list = await listRes.json();
    const row = list.find((p: { id: string }) => p.id === project.id);
    expect(row.repoPath).toBe(dir);
    expect(row.isGit).toBe(false);

    const clearRes = await app.request(`/projects/${project.id}`, {
      method: "PATCH", headers: h, body: JSON.stringify({ repoPath: "" }),
    });
    expect(clearRes.status).toBe(200);
    expect((await clearRes.json()).repoPath).toBeNull();

    rmSync(dir, { recursive: true, force: true });
  });

  it("PATCH /projects/:id 404s for an unknown project", async () => {
    const h = await adminHeaders();
    const res = await app.request("/projects/00000000-0000-0000-0000-000000000000", {
      method: "PATCH", headers: h, body: JSON.stringify({ repoPath: "" }),
    });
    expect(res.status).toBe(404);
  });

  it("git-init creates a repo, flips isGit, and 409s on a repeat call", async () => {
    const h = await adminHeaders();
    const project = await createProject({ key: uniq("pw-proj"), name: "PW" });
    const dir = tmpDir();
    await app.request(`/projects/${project.id}`, {
      method: "PATCH", headers: h, body: JSON.stringify({ repoPath: dir }),
    });

    const initRes = await app.request(`/projects/${project.id}/git-init`, { method: "POST", headers: h });
    expect(initRes.status).toBe(200);
    expect((await initRes.json()).isGit).toBe(true);

    const againRes = await app.request(`/projects/${project.id}/git-init`, { method: "POST", headers: h });
    expect(againRes.status).toBe(409);

    rmSync(dir, { recursive: true, force: true });
  });

  it("git-init 409s when the project has no repoPath set", async () => {
    const h = await adminHeaders();
    const project = await createProject({ key: uniq("pw-proj"), name: "PW" });
    const res = await app.request(`/projects/${project.id}/git-init`, { method: "POST", headers: h });
    expect(res.status).toBe(409);
  });
});
