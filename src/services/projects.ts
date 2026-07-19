import { existsSync, statSync, readdirSync } from "node:fs";
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

// Shared by updateProjectRepo, scanFolder, importProjects.
function assertSafePath(value: string): void {
  if (!/^([a-zA-Z]:[\\/]|\/)/.test(value)) throw new Error(`path must be an absolute path: ${value}`);
  if (value.split(/[\\/]/).includes("..")) {
    throw new Error(`path must not contain ".." segments: ${value}`);
  }
}

// ponytail: case-insensitive lowercase comparison — correct on Windows (this
// app's platform), a false-positive risk only for two differently-cased dirs
// on a case-sensitive filesystem. Upgrade to a real fs.realpath compare if
// that ever bites.
function normalizePath(p: string): string {
  return p.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
}

function kebab(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
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
    assertSafePath(value);
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

export type ScanEntry = { name: string; path: string; isGit: boolean; alreadyProject: boolean };

// Read-only, one level deep, cap 200. Never throws on a stray unreadable dir.
export async function scanFolder(dirPath: string): Promise<ScanEntry[]> {
  assertSafePath(dirPath);
  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
    throw new Error(`path does not exist or is not a directory: ${dirPath}`);
  }

  const existing = await db.select({ repoPath: projects.repoPath }).from(projects);
  const boundPaths = new Set(
    existing.map((p) => p.repoPath).filter((p): p is string => !!p).map(normalizePath)
  );

  const entries = readdirSync(dirPath, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .slice(0, 200);

  return entries.map((e) => {
    const full = join(dirPath, e.name);
    return {
      name: e.name,
      path: full,
      isGit: isGit(full),
      alreadyProject: boundPaths.has(normalizePath(full)),
    };
  });
}

export type ImportItem = { name: string; path: string };

// Reuses createProject + updateProjectRepo (validation included). Fails fast
// on an unsafe path before creating anything, so a rejected item leaves no
// orphan row. ponytail: no transaction around create+repoPath-set — if the
// directory vanishes between scan and import, a project with null repoPath
// can be left behind; wrap in db.transaction if that shows up in practice.
export async function importProjects(items: ImportItem[]): Promise<(Project & { isGit: boolean })[]> {
  const existing = await db.select({ key: projects.key, repoPath: projects.repoPath }).from(projects);
  const existingKeys = new Set(existing.map((p) => p.key));
  const boundPaths = new Set(
    existing.map((p) => p.repoPath).filter((p): p is string => !!p).map(normalizePath)
  );

  // Validate the whole batch BEFORE any insert — a bad path mid-batch must
  // not leave earlier items persisted behind a 400.
  for (const item of items) assertSafePath(item.path);

  const created: (Project & { isGit: boolean })[] = [];
  for (const item of items) {
    if (boundPaths.has(normalizePath(item.path))) continue;

    let base = kebab(item.name) || "project";
    let key = base;
    let suffix = 1;
    while (existingKeys.has(key)) {
      suffix += 1;
      key = `${base}-${suffix}`;
    }
    existingKeys.add(key);

    const project = await createProject({ key, name: item.name });
    const withRepo = await updateProjectRepo(project.id, item.path);
    boundPaths.add(normalizePath(item.path));
    created.push(withRepo);
  }
  return created;
}
