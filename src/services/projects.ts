import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { projects, projectSettings, type Project } from "../db/schema.js";
import { ConflictError, NotFoundError } from "./errors.js";

// Never-throw: a workspace folder can vanish (moved/deleted) after being set.
function isGit(repoPath: string): boolean {
  try {
    return existsSync(join(repoPath, ".git"));
  } catch {
    return false;
  }
}

export async function listProjects(): Promise<(Project & { isGit: boolean })[]> {
  const rows = await db.select().from(projects);
  return rows.map((p) => ({ ...p, isGit: p.repoPath ? isGit(p.repoPath) : false }));
}

export async function createProject(input: { key: string; name: string }): Promise<Project> {
  try {
    const [p] = await db.insert(projects).values({ key: input.key, name: input.name }).returning();
    return p;
  } catch (e) {
    if (String((e as { code?: string }).code) === "23505") {
      throw new ConflictError(`project key already exists: ${input.key}`);
    }
    throw e;
  }
}

// Empty string clears the workspace back to null (falls back to config.workdir).
// Non-empty must be an absolute, existing directory.
export async function updateProjectRepo(id: string, repoPath: string): Promise<Project & { isGit: boolean }> {
  let value: string | null = repoPath.trim();
  if (value === "") {
    value = null;
  } else {
    if (!/^([a-zA-Z]:[\\/]|\/)/.test(value)) throw new Error(`repoPath must be an absolute path: ${value}`);
    if (value.split(/[\\/]/).includes("..")) {
      throw new Error(`repoPath must not contain ".." segments: ${value}`);
    }
    if (!existsSync(value) || !statSync(value).isDirectory()) {
      throw new Error(`repoPath does not exist or is not a directory: ${value}`);
    }
  }
  const [p] = await db.update(projects).set({ repoPath: value }).where(eq(projects.id, id)).returning();
  if (!p) throw new NotFoundError(`project not found: ${id}`);
  return { ...p, isGit: p.repoPath ? isGit(p.repoPath) : false };
}

// Resolution for forge: the project's repoPath if set and still exists on disk, else null
// (caller falls back to config.workdir).
export async function projectWorkdir(projectId: string): Promise<string | null> {
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!p?.repoPath) return null;
  try {
    return existsSync(p.repoPath) ? p.repoPath : null;
  } catch {
    return null;
  }
}

// Arg-vector git, never shell — mirrors forge/sandbox.ts's helper.
function gitInit(cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    const child = spawn("git", ["init", "-b", "main"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (d) => { out += d.toString("utf-8"); });
    child.stderr?.on("data", (d) => { out += d.toString("utf-8"); });
    child.on("close", (code) => res({ code: code ?? 1, out }));
    child.on("error", (e) => res({ code: 1, out: String(e) }));
  });
}

// Sandboxes require a git repo; this bootstraps one in an already-chosen workspace folder.
export async function gitInitProject(id: string): Promise<Project & { isGit: boolean }> {
  const [p] = await db.select().from(projects).where(eq(projects.id, id));
  if (!p) throw new NotFoundError(`project not found: ${id}`);
  if (!p.repoPath) throw new ConflictError("project has no repoPath set");
  if (isGit(p.repoPath)) throw new ConflictError("repoPath is already a git repository");
  const { code, out } = await gitInit(p.repoPath);
  if (code !== 0) throw new Error(`git init failed: ${out.trim()}`);
  return { ...p, isGit: true };
}

export async function getProjectSettings(projectId: string): Promise<Record<string, string>> {
  const rows = await db.select().from(projectSettings).where(eq(projectSettings.projectId, projectId));
  const result: Record<string, string> = {};
  for (const r of rows) result[r.key] = r.value;
  return result;
}

const ALLOWED_SETTINGS = new Set(["github.repo", "gitlab.project", "jira.project", "asana.projectGid"]);

export async function setProjectSetting(projectId: string, key: string, value: string): Promise<void> {
  if (!ALLOWED_SETTINGS.has(key)) throw new Error(`invalid project setting key: ${key}`);
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!p) throw new NotFoundError(`project not found: ${projectId}`);

  if (value === "") {
    await db.delete(projectSettings).where(and(eq(projectSettings.projectId, projectId), eq(projectSettings.key, key)));
  } else {
    await db.insert(projectSettings)
      .values({ projectId, key, value })
      .onConflictDoUpdate({ target: [projectSettings.projectId, projectSettings.key], set: { value } });
  }
}

export async function boundProjects(connectorKey: string): Promise<{ projectId: string; binding: string }[]> {
  const rows = await db.select().from(projectSettings).where(eq(projectSettings.key, connectorKey));
  return rows.map(r => ({ projectId: r.projectId, binding: r.value }));
}
