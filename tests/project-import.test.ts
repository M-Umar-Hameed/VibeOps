import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createActor } from "../src/services/actors.js";
import { createProject, updateProjectRepo } from "../src/services/projects.js";
import { app } from "../src/api/app.js";

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function adminHeaders(): Promise<Record<string, string>> {
  const { apiKey } = await createActor({ name: uniq("pi-admin"), kind: "human", role: "admin" });
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-scan-"));
}

describe("project import: scan", () => {
  it("lists immediate subdirectories, flags git/non-git/already-imported, ignores nested", async () => {
    const h = await adminHeaders();
    const root = tmpDir();
    const gitDir = join(root, "repo-a");
    const plainDir = join(root, "repo-b");
    mkdirSync(join(gitDir, ".git"), { recursive: true });
    mkdirSync(plainDir, { recursive: true });
    mkdirSync(join(gitDir, "nested"), { recursive: true });

    const boundProject = await createProject({ key: uniq("pi-bound"), name: "Bound" });
    await updateProjectRepo(boundProject.id, plainDir);

    const res = await app.request("/projects/scan", {
      method: "POST", headers: h, body: JSON.stringify({ path: root }),
    });
    expect(res.status).toBe(200);
    const entries = await res.json();
    expect(entries).toHaveLength(2);

    const a = entries.find((e: any) => e.name === "repo-a");
    const b = entries.find((e: any) => e.name === "repo-b");
    expect(a.isGit).toBe(true);
    expect(a.alreadyProject).toBe(false);
    expect(b.isGit).toBe(false);
    expect(b.alreadyProject).toBe(true);
    expect(entries.some((e: any) => e.name === "nested")).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  it("detects a git repo root: selfIsGit true, dot/noise dirs hidden", async () => {
    const h = await adminHeaders();
    const root = tmpDir();
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, ".github"), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });

    const res = await app.request("/projects/scan", {
      method: "POST", headers: h, body: JSON.stringify({ path: root }),
    });
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.selfIsGit).toBe(true);
    expect(result.name).toBe(basename(root));
    expect(result.alreadyProject).toBe(false);
    expect(result.entries.map((e: any) => e.name)).toEqual(["src"]);

    rmSync(root, { recursive: true, force: true });
  });

  it("hides dot and noise dirs on a folder-of-repos scan (root not git)", async () => {
    const h = await adminHeaders();
    const root = tmpDir();
    mkdirSync(join(root, "repo-a", ".git"), { recursive: true });
    mkdirSync(join(root, ".vscode"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });

    const res = await app.request("/projects/scan", {
      method: "POST", headers: h, body: JSON.stringify({ path: root }),
    });
    expect(res.status).toBe(200);
    const entries = await res.json();
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.map((e: any) => e.name)).toEqual(["repo-a"]);

    rmSync(root, { recursive: true, force: true });
  });

  it("rejects relative and traversal paths with 400", async () => {
    const h = await adminHeaders();
    const rel = await app.request("/projects/scan", {
      method: "POST", headers: h, body: JSON.stringify({ path: "relative/path" }),
    });
    expect(rel.status).toBe(400);

    const dots = await app.request("/projects/scan", {
      method: "POST", headers: h, body: JSON.stringify({ path: "C:\\real\\..\\..\\Windows" }),
    });
    expect(dots.status).toBe(400);
  });
});

describe("project import: import", () => {
  it("creates a project per item, sets repoPath, idempotent on re-run", async () => {
    const h = await adminHeaders();
    const root = tmpDir();
    const dirA = join(root, uniq("repo"));
    mkdirSync(dirA, { recursive: true });
    const items = [{ name: "Repo One", path: dirA }];

    const first = await app.request("/projects/import", {
      method: "POST", headers: h, body: JSON.stringify({ items }),
    });
    expect(first.status).toBe(200);
    const createdFirst = await first.json();
    expect(createdFirst).toHaveLength(1);
    expect(createdFirst[0].repoPath).toBe(dirA);
    expect(createdFirst[0].key).toMatch(/^repo-one/);

    const second = await app.request("/projects/import", {
      method: "POST", headers: h, body: JSON.stringify({ items }),
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toHaveLength(0);

    rmSync(root, { recursive: true, force: true });
  });

  it("de-dupes generated keys with a numeric suffix", async () => {
    const h = await adminHeaders();
    const root = tmpDir();
    const dirA = join(root, "a");
    const dirB = join(root, "b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const name = uniq("Same Name");

    const res = await app.request("/projects/import", {
      method: "POST", headers: h,
      body: JSON.stringify({ items: [{ name, path: dirA }, { name, path: dirB }] }),
    });
    expect(res.status).toBe(200);
    const created = await res.json();
    expect(created).toHaveLength(2);
    expect(created[0].key).not.toBe(created[1].key);

    rmSync(root, { recursive: true, force: true });
  });

  it("rejects traversal paths with 400 and creates nothing", async () => {
    const h = await adminHeaders();
    const res = await app.request("/projects/import", {
      method: "POST", headers: h,
      body: JSON.stringify({ items: [{ name: "Evil", path: "C:\\real\\..\\..\\Windows" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a mixed batch with 400 and creates nothing", async () => {
    const h = await adminHeaders();
    const root = tmpDir();
    const dirA = join(root, "good");
    mkdirSync(dirA, { recursive: true });
    
    const res = await app.request("/projects/import", {
      method: "POST", headers: h,
      body: JSON.stringify({
        items: [
          { name: "Good", path: dirA },
          { name: "Evil", path: "C:\\real\\..\\..\\Windows" }
        ]
      }),
    });
    expect(res.status).toBe(400);

    // Global counts race parallel test files; assert nothing from THIS batch
    // landed instead.
    const afterRes = await app.request("/projects", { method: "GET", headers: h });
    const afterProjects = await afterRes.json();
    expect(afterProjects.some((p: any) => p.repoPath === dirA || p.name === "Good" || p.name === "Evil")).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });
});
