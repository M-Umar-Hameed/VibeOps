import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { embeddings } from "../db/schema.js";
import { upsertVaultFile, deleteVaultFile, fileHash, fileHashBytes } from "../services/knowledge.js";
import { sweepUnindexedNotes } from "../services/notes.js";
import { sql } from "drizzle-orm";
import { getEmbedder, type Embedder } from "../knowledge/embedder.js";
import { convertPdf } from "./pdf.js";
import { getSetting } from "../services/settings.js";
import { listProjects } from "../services/projects.js";
import { defaultProjectVaultPath, resolveProjectVaultPath } from "./vault-path.js";

let pdfConverter: (path: string) => Promise<string> = convertPdf;
export function setPdfConverter(fn: (path: string) => Promise<string>) { pdfConverter = fn; }

function walkDocs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walkDocs(p));
    else if (name.endsWith(".md") || name.toLowerCase().endsWith(".pdf")) out.push(p);
  }
  return out;
}

export async function reindexFile(absPath: string, embedder: Embedder, ref: string = absPath): Promise<boolean> {
  const isPdf = absPath.toLowerCase().endsWith(".pdf");
  const hash = isPdf ? fileHashBytes(readFileSync(absPath)) : fileHash(readFileSync(absPath, "utf8"));
  const [existing] = await db.select({ h: embeddings.contentHash }).from(embeddings)
    .where(and(eq(embeddings.sourceKind, "vault"), eq(embeddings.sourceRef, ref))).limit(1);
  if (existing && existing.h === hash) return false;
  const text = isPdf ? await pdfConverter(absPath) : readFileSync(absPath, "utf8");
  await upsertVaultFile(ref, text, embedder, hash);
  return true;
}

export async function indexVaultOnce(
  dir: string, embedder: Embedder, refFor: (absPath: string) => string = (p) => p,
): Promise<{ indexed: number; skipped: number }> {
  let indexed = 0, skipped = 0;
  for (const path of walkDocs(dir)) {
    try {
      if (await reindexFile(path, embedder, refFor(path))) indexed++; else skipped++;
    }
    catch (e) { console.error(`ingest failed for ${path}:`, (e as Error).message); }
  }
  return { indexed, skipped };
}

export async function handleUnlink(ref: string): Promise<void> {
  await deleteVaultFile(ref);
}

let watcher: import("chokidar").FSWatcher | null = null;
let starting = false;
let lastSync: Date | null = null;
let lastError: string | null = null;
let vaultPath: string | null = null;
let indexedCount = 0;

export function defaultVaultPath(homeDir = homedir()): string {
  return join(homeDir, ".vibeops", "vault");
}

// Resolution chain: explicit path (caller) > configured setting > default vault.
export async function resolveVaultPath(homeDir?: string): Promise<string> {
  return (await getSetting("obsidian.vault_path")) || defaultVaultPath(homeDir);
}

export async function getVaultStatus() {
  const [res] = await db.select({ count: sql<number>`cast(count(distinct source_ref) as int)` })
    .from(embeddings).where(eq(embeddings.sourceKind, "vault"));
  indexedCount = res?.count || 0;
  return {
    vaultPath: vaultPath ?? (await resolveVaultPath()),
    isRunning: watcher !== null,
    error: lastError,
    lastSync,
    indexedCount,
  };
}

export async function startWatcher(customPath?: string) {
  if (watcher || starting) return;
  starting = true;
  try {
    const dir = customPath ?? await resolveVaultPath();
    // The default vault may not exist yet outside embedded bootstrap (external-PG
    // mode); create it. Never create explicitly configured paths — typos should
    // surface as errors, not empty vaults.
    if (dir === defaultVaultPath()) mkdirSync(dir, { recursive: true });
    vaultPath = dir;
    lastError = null;
    const embedder = getEmbedder();
    try {
      await indexVaultOnce(dir, embedder);
      lastSync = new Date();
    } catch (e) {
      lastError = (e as Error).message;
    }
    await sweepUnindexedNotes(embedder);

    const { default: chokidar } = await import("chokidar");
    watcher = chokidar.watch(dir, { ignoreInitial: true });
    const debounce = new Map<string, NodeJS.Timeout>();
    const reindex = (path: string) => {
      clearTimeout(debounce.get(path));
      debounce.set(path, setTimeout(async () => {
        try { await reindexFile(path, embedder); lastSync = new Date(); lastError = null; }
        catch (e) { lastError = (e as Error).message; console.error(`ingest failed for ${path}:`, (e as Error).message); }
      }, 300));
    };
    watcher.on("add", reindex).on("change", reindex).on("unlink", (p) => handleUnlink(p).catch(() => {}));
  } finally {
    starting = false;
  }
}

export async function stopWatcher() {
  if (watcher) {
    await watcher.close();
    watcher = null;
  }
}

const STARTER_README =
  "# VibeOps Vault\n\nDrop markdown files here — VibeOps indexes them into knowledge search automatically.\n" +
  "Open this folder as an Obsidian vault if you use Obsidian; any editor works.\n";

const projectWatchers = new Map<string, import("chokidar").FSWatcher>();
const watchedPath = new Map<string, string>();
const lastSyncByProject = new Map<string, Date>();
const lastErrorByProject = new Map<string, string | null>();

function vaultRef(projectId: string, root: string, absPath: string): string {
  return `${projectId}:${relative(root, absPath).split(sep).join("/")}`;
}

// Test/introspection helper: which project vaults are currently watched.
export function watchedProjectPaths(): Map<string, string> {
  return new Map(watchedPath);
}

async function startProjectVault(projectId: string, dir: string, embedder: Embedder): Promise<void> {
  // Same as the default global vault: create default dirs on demand with a
  // starter note; never create an explicitly overridden path (typos should
  // surface as errors, not empty vaults).
  if (dir === defaultProjectVaultPath(projectId)) {
    mkdirSync(dir, { recursive: true });
    const starter = join(dir, "README.md");
    if (!existsSync(starter)) writeFileSync(starter, STARTER_README);
  }
  const refOf = (absPath: string) => vaultRef(projectId, dir, absPath);
  lastErrorByProject.set(projectId, null);
  try {
    await indexVaultOnce(dir, embedder, refOf);
    lastSyncByProject.set(projectId, new Date());
  } catch (e) {
    lastErrorByProject.set(projectId, (e as Error).message);
  }
  const { default: chokidar } = await import("chokidar");
  const w = chokidar.watch(dir, { ignoreInitial: true });
  const debounce = new Map<string, NodeJS.Timeout>();
  const reindex = (absPath: string) => {
    clearTimeout(debounce.get(absPath));
    debounce.set(absPath, setTimeout(async () => {
      try { await reindexFile(absPath, embedder, refOf(absPath)); lastSyncByProject.set(projectId, new Date()); lastErrorByProject.set(projectId, null); }
      catch (e) { lastErrorByProject.set(projectId, (e as Error).message); console.error(`ingest failed for ${absPath}:`, (e as Error).message); }
    }, 300));
  };
  w.on("add", reindex).on("change", reindex).on("unlink", (p) => handleUnlink(refOf(p)).catch(() => {}));
  projectWatchers.set(projectId, w);
  watchedPath.set(projectId, dir);
}

let rescanChain: Promise<void> = Promise.resolve();
// Serialized so a boot rescan and a settings-triggered rescan never double-watch.
export function rescanProjectVaults(embedder: Embedder = getEmbedder()): Promise<void> {
  rescanChain = rescanChain
    .then(() => doRescanProjectVaults(embedder))
    .catch((e) => { console.warn(`project vault rescan failed: ${(e as Error).message}`); });
  return rescanChain;
}

async function doRescanProjectVaults(embedder: Embedder): Promise<void> {
  const allProjects = await listProjects();
  const desired = new Map<string, string>();
  for (const p of allProjects) {
    const dir = await resolveProjectVaultPath(p.id);
    // Only watch if the vault directory exists or there's an explicit override.
    // This avoids creating vault dirs for every project at boot (which is slow).
    // The vault gets created on demand when the user first visits vault settings.
    if (dir !== defaultProjectVaultPath(p.id) || existsSync(dir)) {
      desired.set(p.id, dir);
    }
  }
  // Stop watchers for removed projects or changed override paths.
  for (const [pid, w] of projectWatchers) {
    if (!desired.has(pid) || watchedPath.get(pid) !== desired.get(pid)) {
      await w.close();
      projectWatchers.delete(pid);
      watchedPath.delete(pid);
    }
  }
  // Start watchers for new or re-pointed projects.
  for (const [pid, dir] of desired) {
    if (projectWatchers.has(pid)) continue;
    await startProjectVault(pid, dir, embedder);
  }
}

export async function stopProjectVaults(): Promise<void> {
  for (const [, w] of projectWatchers) await w.close();
  projectWatchers.clear();
  watchedPath.clear();
  lastSyncByProject.clear();
  lastErrorByProject.clear();
}

export async function getProjectVaultStatus(projectId: string) {
  const [res] = await db.select({ count: sql<number>`cast(count(distinct source_ref) as int)` })
    .from(embeddings)
    .where(and(eq(embeddings.sourceKind, "vault"), sql`source_ref LIKE ${projectId + ":%"}`));
  return {
    projectId,
    vaultPath: watchedPath.get(projectId) ?? (await resolveProjectVaultPath(projectId)),
    isRunning: projectWatchers.has(projectId),
    indexedCount: res?.count || 0,
    lastSync: lastSyncByProject.get(projectId) ?? null,
    error: lastErrorByProject.get(projectId) ?? null,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.env.VAULT_PATH && await startWatcher(process.env.VAULT_PATH);
}

