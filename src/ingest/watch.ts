import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { embeddings } from "../db/schema.js";
import { upsertVaultFile, deleteVaultFile, fileHash } from "../services/knowledge.js";
import { sweepUnindexedNotes } from "../services/notes.js";
import { getEmbedder, type Embedder } from "../knowledge/embedder.js";

function walkMd(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walkMd(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

export async function indexVaultOnce(
  dir: string, embedder: Embedder,
): Promise<{ indexed: number; skipped: number }> {
  let indexed = 0, skipped = 0;
  for (const path of walkMd(dir)) {
    const text = readFileSync(path, "utf8");
    const hash = fileHash(text);
    const [existing] = await db.select({ h: embeddings.contentHash }).from(embeddings)
      .where(and(eq(embeddings.sourceKind, "vault"), eq(embeddings.sourceRef, path))).limit(1);
    if (existing && existing.h === hash) { skipped++; continue; }
    try { await upsertVaultFile(path, text, embedder); indexed++; }
    catch (e) { console.error(`ingest failed for ${path}:`, (e as Error).message); }
  }
  return { indexed, skipped };
}

export async function handleUnlink(path: string): Promise<void> {
  await deleteVaultFile(path);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.env.VAULT_PATH;
  if (!dir) throw new Error("VAULT_PATH not set");
  const embedder = getEmbedder();
  const { default: chokidar } = await import("chokidar");
  await indexVaultOnce(dir, embedder);
  await sweepUnindexedNotes(embedder);
  const debounce = new Map<string, NodeJS.Timeout>();
  const reindex = (path: string) => {
    clearTimeout(debounce.get(path));
    debounce.set(path, setTimeout(async () => {
      try { await upsertVaultFile(path, readFileSync(path, "utf8"), embedder); }
      catch (e) { console.error(`ingest failed for ${path}:`, (e as Error).message); }
    }, 300));
  };
  chokidar.watch(dir, { ignoreInitial: true })
    .on("add", reindex).on("change", reindex)
    .on("unlink", (p) => handleUnlink(p).catch(() => {}));
  console.log(`watching ${dir}`);
}
