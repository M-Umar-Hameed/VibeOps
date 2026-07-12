import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

export async function reindexFile(path: string, embedder: Embedder): Promise<boolean> {
  const isPdf = path.toLowerCase().endsWith(".pdf");
  const hash = isPdf ? fileHashBytes(readFileSync(path)) : fileHash(readFileSync(path, "utf8"));
  const [existing] = await db.select({ h: embeddings.contentHash }).from(embeddings)
    .where(and(eq(embeddings.sourceKind, "vault"), eq(embeddings.sourceRef, path))).limit(1);
  if (existing && existing.h === hash) return false;
  const text = isPdf ? await pdfConverter(path) : readFileSync(path, "utf8");
  await upsertVaultFile(path, text, embedder, hash);
  return true;
}

export async function indexVaultOnce(
  dir: string, embedder: Embedder,
): Promise<{ indexed: number; skipped: number }> {
  let indexed = 0, skipped = 0;
  for (const path of walkDocs(dir)) {
    try {
      if (await reindexFile(path, embedder)) indexed++; else skipped++;
    }
    catch (e) { console.error(`ingest failed for ${path}:`, (e as Error).message); }
  }
  return { indexed, skipped };
}

export async function handleUnlink(path: string): Promise<void> {
  await deleteVaultFile(path);
}

let watcher: import("chokidar").FSWatcher | null = null;
let lastSync: Date | null = null;
let lastError: string | null = null;
let vaultPath: string | null = null;
let indexedCount = 0;

export function defaultVaultPath(homeDir = homedir()): string {
  return join(homeDir, ".vibeops", "vault");
}

// Resolution chain: explicit path (caller) > configured setting > default vault.
export async function resolveVaultPath(homeDir?: string): Promise<string> {
  return (await getSetting("obsidian.vault_path")) ?? defaultVaultPath(homeDir);
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
  if (watcher) return;
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
}

export async function stopWatcher() {
  if (watcher) {
    await watcher.close();
    watcher = null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.env.VAULT_PATH && await startWatcher(process.env.VAULT_PATH);
}

