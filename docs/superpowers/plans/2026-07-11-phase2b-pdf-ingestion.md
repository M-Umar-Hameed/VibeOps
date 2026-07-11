# Phase 2b — PDF Ingestion + Graphify Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The vault watcher ingests `.pdf` files (converting them to markdown via `@opendataloader/pdf`) into the existing pgvector pipeline, so PDFs are retrievable via `search_knowledge` with the PDF path as citation. Plus a README section documenting graphify as an agent-side skill.

**Architecture:** A `convertPdf` seam turns a PDF into markdown in a temp dir outside the vault; the shared hash-gated `reindexFile` branches on extension (PDFs hash their raw bytes, markdown hashes utf8 text) and feeds the same `upsertVaultFile` chunk→embed path. The gate hash is threaded into `upsertVaultFile` so a PDF's stored `contentHash` matches its byte-hash on re-index.

**Tech Stack:** Node ESM, `@opendataloader/pdf` (requires Java 11+ on the watcher machine), Postgres+pgvector, vitest.

**Spec:** `docs/superpowers/specs/2026-07-11-phase2b-pdf-ingestion-design.md`

## Global Constraints

- Node ESM (`.js` import extensions). Postgres+pgvector on host port 5433.
- PDFs hash their RAW BYTES for the gate (utf8 hashing would mangle binary); markdown unchanged.
- `convertPdf` writes to a temp dir OUTSIDE the vault, reads the produced `.md`, cleans up — never the default next-to-input output (would double-ingest into the vault).
- Conversion behind an injectable seam (`setPdfConverter`) so CI uses a fake (no JVM).
- One bad PDF logs + is skipped; a missing JVM warns once and skips PDFs; the watcher never crashes and markdown ingestion is unaffected.
- No emojis; minimal comments/logs.
- Reuse verbatim: `upsertVaultFile`, `deleteVaultFile`, `fileHash`, `reindexFile`, `indexVaultOnce`, `handleUnlink`, `FakeEmbedder`.

## File Structure

- `src/services/knowledge.ts` — add `fileHashBytes(buf)`; add optional `contentHash` param to `upsertVaultFile`.
- `src/ingest/pdf.ts` — new: `convertPdf(path): Promise<string>`.
- `src/ingest/watch.ts` — `walkMd`→`walkDocs` (.md + .pdf); `reindexFile` branches on extension; add `setPdfConverter` seam; chokidar routes `.pdf`.
- `README.md` — Java-11 requirement for PDFs + graphify agent-skill section.
- `package.json` — add `@opendataloader/pdf`.
- `tests/` — `fileHashBytes` unit; PDF ingestion with a fake converter.

---

### Task 1: Binary hash + upsertVaultFile hash param + convertPdf module

**Files:**
- Modify: `src/services/knowledge.ts`, `package.json`
- Create: `src/ingest/pdf.ts`, `tests/pdf-hash.test.ts`

**Interfaces:**
- Produces: `fileHashBytes(buf: Buffer): string`; `upsertVaultFile(path, text, embedder, contentHash?)` (when `contentHash` omitted, defaults to `fileHash(text)` — backward compatible); `convertPdf(path: string): Promise<string>`.

- [ ] **Step 1: Add `@opendataloader/pdf` to `package.json` deps and install**

Add `"@opendataloader/pdf": "^2.4.7"` to dependencies. Run `npm install`.

- [ ] **Step 2: Add `fileHashBytes` and thread `contentHash` into `upsertVaultFile` in `src/services/knowledge.ts`**

Add near `fileHash`:
```ts
export function fileHashBytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
```
Change `upsertVaultFile` signature + the stored hash:
```ts
export async function upsertVaultFile(
  path: string, text: string, embedder: Embedder, contentHash?: string,
): Promise<number> {
  const chunks = chunkMarkdown(text);
  const hash = contentHash ?? fileHash(text);
  // ...rest unchanged (delete old rows, embed, insert with contentHash: hash)...
}
```
Only the `hash` line changes (was `const hash = fileHash(text);`). Everything else stays. `createHash` is already imported in this file.

- [ ] **Step 3: Create `src/ingest/pdf.ts`**

```ts
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convert } from "@opendataloader/pdf";

// Convert a PDF to markdown text. Writes to a temp dir OUTSIDE the vault
// (the default output is next to the input, which the watcher would re-ingest),
// reads the produced markdown, and cleans up.
export async function convertPdf(path: string): Promise<string> {
  const out = mkdtempSync(join(tmpdir(), "odl-"));
  try {
    await convert(path, { outputDir: out, format: "markdown", quiet: true });
    const md = readdirSync(out).find((f) => f.endsWith(".md"));
    if (!md) throw new Error(`no markdown produced for ${path}`);
    return readFileSync(join(out, md), "utf8");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Write `tests/pdf-hash.test.ts`**

```ts
import { expect, test } from "vitest";
import { fileHashBytes } from "../src/services/knowledge.js";

test("fileHashBytes: identical bytes hash equal, different bytes differ", () => {
  const a = Buffer.from([1, 2, 3, 255, 0]);
  const b = Buffer.from([1, 2, 3, 255, 0]);
  const c = Buffer.from([1, 2, 3, 255, 1]);
  expect(fileHashBytes(a)).toBe(fileHashBytes(b));
  expect(fileHashBytes(a)).not.toBe(fileHashBytes(c));
  expect(fileHashBytes(a)).toHaveLength(64);
});
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npm test -- pdf-hash` then full `npm test` (existing upsertVaultFile callers unaffected by the optional param) then `npm run typecheck`.
Expected: all green. `convertPdf` is not CI-tested (needs a JVM) — typecheck confirms it compiles; a manual live check is in Task 2's acceptance.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: binary file hashing, threaded contentHash, and pdf-to-markdown converter"
```

---

### Task 2: Watcher ingests PDFs

**Files:**
- Modify: `src/ingest/watch.ts`
- Create: `tests/pdf-ingest.test.ts`

**Interfaces:**
- Consumes: `convertPdf`, `fileHashBytes`, `upsertVaultFile` (with contentHash), `fileHash`.
- Produces: `setPdfConverter(fn: (path: string) => Promise<string>)`; `walkDocs` (internal); `reindexFile` now handles `.pdf`.

- [ ] **Step 1: Write `tests/pdf-ingest.test.ts`** (fake converter — no JVM)

```ts
import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, and } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { embeddings } from "../src/db/schema.js";
import { FakeEmbedder } from "../src/knowledge/embedder.js";
import { indexVaultOnce, handleUnlink, setPdfConverter } from "../src/ingest/watch.js";
import { searchKnowledge } from "../src/services/knowledge.js";

const emb = new FakeEmbedder(1024);
const rows = (p: string) =>
  db.select().from(embeddings).where(and(eq(embeddings.sourceKind, "vault"), eq(embeddings.sourceRef, p)));

test("pdf files are converted, indexed, hash-gated, retrievable, and deleted", async () => {
  const uniq = `pdf-${Date.now()}-${Math.round(performance.now() * 1000)}`;
  const md = `# Report ${uniq}\nquarterly numbers and pipeline health`;
  setPdfConverter(async () => md); // fake: no JVM

  const dir = mkdtempSync(join(tmpdir(), "vault-pdf-"));
  const file = join(dir, "report.pdf");
  writeFileSync(file, Buffer.from([0x25, 0x50, 0x44, 0x46, 1, 2, 3])); // "%PDF" + bytes

  const r1 = await indexVaultOnce(dir, emb);
  expect(r1.indexed).toBe(1);
  expect((await rows(file)).length).toBeGreaterThan(0);

  const r2 = await indexVaultOnce(dir, emb);          // unchanged bytes -> skipped
  expect(r2.skipped).toBe(1);
  expect(r2.indexed).toBe(0);

  const hits = await searchKnowledge(md, { limit: 5 }, emb); // query exact converted text
  expect(hits.some((h) => h.sourceRef === file)).toBe(true);

  writeFileSync(file, Buffer.from([0x25, 0x50, 0x44, 0x46, 9, 9, 9])); // changed bytes
  const r3 = await indexVaultOnce(dir, emb);
  expect(r3.indexed).toBe(1);

  await handleUnlink(file);
  expect((await rows(file)).length).toBe(0);

  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- pdf-ingest`
Expected: FAIL (`setPdfConverter` not exported; PDFs not walked/handled).

- [ ] **Step 3: Edit `src/ingest/watch.ts`**

Add imports:
```ts
import { fileHash, fileHashBytes, upsertVaultFile, deleteVaultFile } from "../services/knowledge.js";
import { convertPdf } from "./pdf.js";
```
(merge with the existing knowledge import — it currently imports `upsertVaultFile, deleteVaultFile, fileHash`; add `fileHashBytes`.)

Add the converter seam near the top (module scope):
```ts
let pdfConverter: (path: string) => Promise<string> = convertPdf;
export function setPdfConverter(fn: (path: string) => Promise<string>) { pdfConverter = fn; }
```

Rename `walkMd` → `walkDocs` and match both extensions:
```ts
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
```
Update the `indexVaultOnce` loop to iterate `walkDocs(dir)`.

Rewrite `reindexFile` to branch on extension (raw-byte hash for PDFs, threaded into `upsertVaultFile`):
```ts
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
```
Note: `db`, `embeddings`, `and`, `eq`, `readFileSync` are already imported in watch.ts (verify; add any missing). The stored `contentHash` is now the SOURCE hash (bytes for PDF, text for md), so the gate matches on re-index.

The chokidar `add`/`change` handler already calls `reindexFile`, so PDFs route through automatically; `unlink` deletes by `sourceRef` (path) generically — unchanged. No handler edits needed beyond the `reindexFile`/`walkDocs` changes.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- pdf-ingest` then full `npm test` then `npm run typecheck`.
Expected: all green (markdown ingestion tests still pass — `.md` path unchanged; PDF path proven with the fake converter).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: watcher ingests pdf files via convertPdf with byte-hash gating"
```

---

### Task 3: README — Java requirement + graphify agent skill

**Files:**
- Modify: `README.md` (create if absent)

- [ ] **Step 1: Add a "PDF ingestion" note to `README.md`**

Document: the vault watcher ingests `.pdf` in addition to `.md`; PDF conversion uses `@opendataloader/pdf`, which requires **Java 11+** on the machine running `npm run ingest:watch`; without a JVM, PDFs are skipped (one startup warning) and markdown ingestion continues. Each PDF conversion spawns a JVM (slow), which is why unchanged PDFs are hash-gated and skipped.

- [ ] **Step 2: Add a "Graphify (agent-side knowledge graph)" section to `README.md`**

Document: graphify (MIT; https://github.com/Graphify-Labs/graphify) is an AI-assistant skill that turns a folder of code/docs/schemas into a queryable knowledge graph (GraphRAG). Install it on the agent machine (Claude Code / Codex / Gemini / Cursor) and point it at the Obsidian vault + this repo. Use its graph queries for entity/relationship questions alongside the server's `search_knowledge` (pgvector semantic search). It runs entirely agent-side; the tickets server neither depends on nor invokes it.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "docs: document pdf ingestion java requirement and graphify agent skill"
```

---

## Phase 2b acceptance

- `npm test` green: `fileHashBytes` unit; PDF ingested via fake converter → retrievable by `search_knowledge` with the PDF path as citation; unchanged PDF byte-hash-gated (skipped); changed PDF re-indexed; deleted PDF removed. Markdown ingestion unaffected. Typecheck clean.
- Manual live check (with Java present): drop a real `.pdf` into the vault, run `npm run ingest:watch`, then query its content via MCP `search_knowledge` — returns the PDF path as citation.
- README documents the Java 11+ requirement and the graphify agent-skill setup.

## Self-review notes (done)

- Spec coverage: `.pdf` walked + ingested (Task 2), byte-hash gate threaded through upsertVaultFile (Tasks 1-2), convertPdf temp-dir-outside-vault (Task 1), injectable seam + fake converter in CI (Task 2), delete-on-unlink reused, README Java + graphify (Task 3). Covered.
- Type consistency: `upsertVaultFile(path, text, embedder, contentHash?)`, `fileHashBytes(buf)`, `convertPdf(path)`, `setPdfConverter(fn)` used identically across knowledge.ts, watch.ts, and tests.
- The one correctness risk (gate hash vs stored contentHash mismatch for PDFs) is closed by threading the source hash into `upsertVaultFile` — verified in the reindexFile/upsertVaultFile pairing.
- Backward compat: `contentHash` is optional and defaults to `fileHash(text)`, so existing markdown callers and their tests are unaffected.
