# Session-Transcript Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Cross-tool session history in VibeOps knowledge: ingest claude-mem observations (SQLite) + Claude Code transcripts (jsonl) as a new `session` source kind, hash-gated, via a rerunnable `npm run ingest:sessions` CLI. `search_knowledge` surfaces them unchanged — every MCP-connected tool sees what happened in every session.

**Architecture:** `SessionSource` interface + two readers (`node:sqlite` for claude-mem — zero new deps; jsonl parser keeping only user/assistant text). `upsertVaultFile` generalizes to `upsertSourceDoc(kind, ref, text, embedder, hash)` (vault wrapper unchanged). `'session'` added to the `source_kind` enum (additive migration).

**Spec:** `docs/superpowers/specs/2026-07-12-session-memory-design.md`

## Global Constraints

- Node ESM (`.js` imports). Suite runs on real PG :5433 (VITEST guard); embedded mode gets the enum via the committed migration at boot.
- `node:sqlite` (`DatabaseSync`) — verified working on this Node 24; open claude-mem DB **read-only**.
- Transcript extraction keeps ONLY: `type==="user"` message text (string content, or list items that are strings or `{type:"text"}` blocks — skip `tool_result` blocks) and `type==="assistant"` `{type:"text"}` blocks (skip `thinking`, `tool_use`). Everything else (queue-operation, attachment, file-history-snapshot, ai-title, etc.) is noise.
- Default ingestion window 30 days (`SESSIONS_SINCE_DAYS` env). claude-mem rows filter on `created_at_epoch`; transcript files filter on mtime.
- Per-doc/source failures log + skip; missing source dirs are silent skips. Never throw out of the CLI loop.
- Vault/PDF ingestion behavior must remain byte-identical (existing tests are the regression net).
- No emojis; minimal comments/logs. Reuse verbatim: `chunkMarkdown`, `getEmbedder`/`FakeEmbedder`, `fileHash`, `fileHashBytes`, the embeddings delete+insert machinery.

## File Structure

- `src/db/schema.ts` — enum gains `"session"`.
- `drizzle/000X_*.sql` — generated additive migration.
- `src/services/knowledge.ts` — `upsertSourceDoc` (generalized), `upsertVaultFile` wrapper.
- `src/ingest/sessions/source.ts` — `SessionSource`, `SessionDoc`.
- `src/ingest/sessions/claude-mem.ts` — `makeClaudeMemSource(dbPath?)`.
- `src/ingest/sessions/claude-code.ts` — `makeClaudeCodeSource(projectsDir?)`.
- `src/ingest/sessions/cli.ts` — entrypoint.
- `package.json` — `"ingest:sessions": "tsx src/ingest/sessions/cli.ts"`.
- `tests/` — `session-schema.test.ts`, `claude-mem-reader.test.ts`, `claude-code-reader.test.ts`, `session-ingest.test.ts`.

---

### Task 1: Enum migration + upsertSourceDoc generalization

**Files:**
- Modify: `src/db/schema.ts`, `src/services/knowledge.ts`, `package.json` (script)
- Create: generated `drizzle/` migration, `tests/session-schema.test.ts`

**Interfaces:**
- `sourceKind` enum values: `["vault", "note", "session"]`.
- `upsertSourceDoc(kind: "vault" | "note" | "session", ref: string, text: string, embedder: Embedder, contentHash?: string): Promise<number>` — exactly the current `upsertVaultFile` body with `kind` parameterized (delete old `(kind, ref)` rows, chunk, embed, insert, return count).
- `upsertVaultFile(path, text, embedder, contentHash?)` — one-line wrapper calling `upsertSourceDoc("vault", ...)`. Signature unchanged.

- [ ] **Step 1:** In `src/db/schema.ts` change the enum: `export const sourceKind = pgEnum("source_kind", ["vault", "note", "session"]);`
- [ ] **Step 2:** `npm run db:generate` → inspect the new migration file: it must be additive (`ALTER TYPE "public"."source_kind" ADD VALUE 'session';` or drizzle's equivalent). Commit it. Then `npm run db:push` (applies to the :5433 test DB; accept prompts — additive only; note what you did).
- [ ] **Step 3:** In `src/services/knowledge.ts` refactor:

```ts
export async function upsertSourceDoc(
  kind: "vault" | "note" | "session", ref: string, text: string,
  embedder: Embedder, contentHash?: string,
): Promise<number> {
  const chunks = chunkMarkdown(text);
  const hash = contentHash ?? fileHash(text);
  await db.delete(embeddings)
    .where(and(eq(embeddings.sourceKind, kind), eq(embeddings.sourceRef, ref)));
  if (chunks.length === 0) return 0;
  const vecs = await embedder.embed(chunks.map((c) => c.content));
  await db.insert(embeddings).values(chunks.map((c, i) => ({
    sourceKind: kind, sourceRef: ref, chunkIndex: c.index,
    content: c.content, embedding: vecs[i], model: embedder.model, dim: embedder.dim,
    contentHash: hash,
  })));
  return chunks.length;
}

export async function upsertVaultFile(path: string, text: string, embedder: Embedder, contentHash?: string): Promise<number> {
  return upsertSourceDoc("vault", path, text, embedder, contentHash);
}
```
(Replaces the old `upsertVaultFile` body; nothing else in the file changes.)

- [ ] **Step 4:** Write `tests/session-schema.test.ts`:

```ts
import { expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { embeddings } from "../src/db/schema.js";
import { upsertSourceDoc, searchKnowledge } from "../src/services/knowledge.js";
import { FakeEmbedder } from "../src/knowledge/embedder.js";

const emb = new FakeEmbedder(1024);

test("session sourceKind round-trips through upsertSourceDoc with hash gating semantics", async () => {
  const ref = `claude-mem#test-${Date.now()}`;
  const text = `# Session\nunique-session-marker-${Date.now()}-${Math.round(performance.now() * 1000)}`;
  const n = await upsertSourceDoc("session", ref, text, emb, "hash-1");
  expect(n).toBeGreaterThan(0);
  const rows = await db.select().from(embeddings)
    .where(and(eq(embeddings.sourceKind, "session"), eq(embeddings.sourceRef, ref)));
  expect(rows.length).toBe(n);
  expect(rows[0].contentHash).toBe("hash-1");
  const hits = await searchKnowledge(text, { limit: 5 }, emb);
  expect(hits.some((h) => h.sourceRef === ref && h.sourceKind === "session")).toBe(true);
});
```

- [ ] **Step 5:** Run `npm test -- session-schema`, FULL `npm test` (vault tests = regression net for the wrapper), `npm run typecheck`.
- [ ] **Step 6:** Commit: `git add -A && git commit -m "feat: session source kind and generalized source-doc upsert"`

---

### Task 2: claude-mem reader

**Files:**
- Create: `src/ingest/sessions/source.ts`, `src/ingest/sessions/claude-mem.ts`, `tests/claude-mem-reader.test.ts`

**Interfaces:**
- `source.ts`:
```ts
export type SessionDoc = { ref: string; text: string; hash: string };
export interface SessionSource {
  source: string;
  listSessionDocs(sinceDays: number): Promise<SessionDoc[]>;
}
```
- `makeClaudeMemSource(dbPath = join(homedir(), ".claude-mem", "claude-mem.db")): SessionSource` with `source = "claude-mem"`.

- [ ] **Step 1:** Write `source.ts` (above, verbatim).
- [ ] **Step 2:** Write `tests/claude-mem-reader.test.ts` — build a fixture DB with `node:sqlite` in a temp dir:

```ts
import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeClaudeMemSource } from "../src/ingest/sessions/claude-mem.js";

function fixture(dir: string): string {
  const path = join(dir, "claude-mem.db");
  const db = new DatabaseSync(path);
  db.exec(`create table observations (
    id integer primary key, title text, narrative text, facts text, concepts text,
    project text, created_at_epoch integer)`);
  const now = Date.now();
  const ins = db.prepare("insert into observations (id,title,narrative,facts,concepts,project,created_at_epoch) values (?,?,?,?,?,?,?)");
  ins.run(1, "Fixed auth bug", "Token check used < not <=", '["fact-a"]', '["auth"]', "proj", now);
  ins.run(2, "Old work", "ancient", null, null, "proj", now - 90 * 24 * 3600 * 1000);
  db.close();
  return path;
}

test("claude-mem source lists windowed observation docs; absent db yields empty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmem-"));
  const src = makeClaudeMemSource(fixture(dir));
  const docs = await src.listSessionDocs(30);
  expect(docs).toHaveLength(1); // 90-day-old row excluded
  expect(docs[0].ref).toBe("claude-mem#1");
  expect(docs[0].text).toContain("Fixed auth bug");
  expect(docs[0].text).toContain("Token check");
  expect(docs[0].hash).toHaveLength(64);

  const none = makeClaudeMemSource(join(dir, "missing.db"));
  expect(await none.listSessionDocs(30)).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 3:** Confirm FAIL, then write `claude-mem.ts`:

```ts
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileHash } from "../../services/knowledge.js";
import type { SessionSource, SessionDoc } from "./source.js";

export function makeClaudeMemSource(
  dbPath = join(homedir(), ".claude-mem", "claude-mem.db"),
): SessionSource {
  return {
    source: "claude-mem",
    async listSessionDocs(sinceDays: number): Promise<SessionDoc[]> {
      if (!existsSync(dbPath)) return [];
      const { DatabaseSync } = await import("node:sqlite");
      let db;
      try {
        db = new DatabaseSync(dbPath, { readOnly: true });
      } catch (e) {
        console.warn(`claude-mem db unreadable, skipping: ${(e as Error).message}`);
        return [];
      }
      try {
        const cutoff = Date.now() - sinceDays * 24 * 3600 * 1000;
        const rows = db.prepare(
          "select id, title, narrative, facts, concepts, project from observations where created_at_epoch >= ? order by id",
        ).all(cutoff) as { id: number; title: string | null; narrative: string | null; facts: string | null; concepts: string | null; project: string | null }[];
        return rows.map((r) => {
          const text = [r.project && `project: ${r.project}`, r.title, r.narrative, r.facts, r.concepts]
            .filter(Boolean).join("\n");
          return { ref: `claude-mem#${r.id}`, text, hash: fileHash(text) };
        });
      } catch (e) {
        console.warn(`claude-mem query failed, skipping: ${(e as Error).message}`);
        return [];
      } finally {
        db.close();
      }
    },
  };
}
```
Note: if the real DB's `created_at_epoch` is in seconds rather than ms in some rows, the cutoff comparison still behaves (seconds values are simply "very old"); the fixture pins ms semantics matching the surveyed data (`created_at_epoch` ≈ 1.7e12 = ms).

- [ ] **Step 4:** `npm test -- claude-mem-reader`, full suite, typecheck. Commit: `feat: claude-mem session source reader`.

---

### Task 3: Claude Code transcript reader

**Files:**
- Create: `src/ingest/sessions/claude-code.ts`, `tests/claude-code-reader.test.ts`

**Interfaces:**
- `makeClaudeCodeSource(projectsDir = join(homedir(), ".claude", "projects")): SessionSource`, `source = "claude-code"`.

- [ ] **Step 1:** Write `tests/claude-code-reader.test.ts`:

```ts
import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeClaudeCodeSource } from "../src/ingest/sessions/claude-code.js";

test("transcript reader keeps user/assistant text, strips tool noise, windows by mtime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccode-"));
  const proj = join(dir, "D--Some-Proj");
  mkdirSync(proj);
  const lines = [
    JSON.stringify({ type: "queue-operation", operation: "x" }),
    JSON.stringify({ type: "user", message: { role: "user", content: "fix the login bug" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
      { type: "thinking", thinking: "secret reasoning" },
      { type: "text", text: "The bug is in auth.ts line 5" },
      { type: "tool_use", name: "Bash", input: { command: "cat /etc/passwd" } },
    ] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [
      { type: "tool_result", content: "root:x:0:0" },
      { type: "text", text: "thanks, also check signup" },
    ] } }),
    "not json at all",
  ].join("\n");
  writeFileSync(join(proj, "session-1.jsonl"), lines);

  const src = makeClaudeCodeSource(dir);
  const docs = await src.listSessionDocs(30);
  expect(docs).toHaveLength(1);
  const t = docs[0].text;
  expect(t).toContain("fix the login bug");
  expect(t).toContain("auth.ts line 5");
  expect(t).toContain("also check signup");
  expect(t).not.toContain("secret reasoning");
  expect(t).not.toContain("/etc/passwd");
  expect(t).not.toContain("root:x:0:0");
  expect(docs[0].ref).toBe(join(proj, "session-1.jsonl"));
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2:** Confirm FAIL, then write `claude-code.ts`:

```ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileHashBytes } from "../../services/knowledge.js";
import type { SessionSource, SessionDoc } from "./source.js";

function extractText(raw: string): string {
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (d?.type !== "user" && d?.type !== "assistant") continue;
    const content = d.message?.content;
    if (typeof content === "string") { if (content.trim()) out.push(content.trim()); continue; }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block === "string") { if (block.trim()) out.push(block.trim()); continue; }
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) out.push(block.text.trim());
    }
  }
  return out.join("\n\n");
}

export function makeClaudeCodeSource(
  projectsDir = join(homedir(), ".claude", "projects"),
): SessionSource {
  return {
    source: "claude-code",
    async listSessionDocs(sinceDays: number): Promise<SessionDoc[]> {
      if (!existsSync(projectsDir)) return [];
      const cutoff = Date.now() - sinceDays * 24 * 3600 * 1000;
      const docs: SessionDoc[] = [];
      for (const proj of readdirSync(projectsDir)) {
        const pdir = join(projectsDir, proj);
        let entries: string[];
        try { if (!statSync(pdir).isDirectory()) continue; entries = readdirSync(pdir); } catch { continue; }
        for (const name of entries) {
          if (!name.endsWith(".jsonl")) continue;
          const path = join(pdir, name);
          try {
            if (statSync(path).mtimeMs < cutoff) continue;
            const buf = readFileSync(path);
            const text = extractText(buf.toString("utf8"));
            if (!text) continue;
            docs.push({ ref: path, text, hash: fileHashBytes(buf) });
          } catch (e) {
            console.warn(`transcript skipped ${path}: ${(e as Error).message}`);
          }
        }
      }
      return docs;
    },
  };
}
```

- [ ] **Step 3:** `npm test -- claude-code-reader`, full suite, typecheck. Commit: `feat: claude code transcript session source reader`.

---

### Task 4: Ingest CLI + end-to-end retrieval

**Files:**
- Create: `src/ingest/sessions/cli.ts`, `tests/session-ingest.test.ts`
- Modify: `package.json` (script), `README.md` (short section)

**Interfaces:**
- `ingestSessions(sources: SessionSource[], embedder?: Embedder, sinceDays?: number): Promise<Record<string, { indexed: number; skipped: number; failed: number }>>` — exported for tests; hash-gates per doc against stored `contentHash` for `(session, ref)`; upserts changed/new via `upsertSourceDoc("session", ...)`; per-doc failure → log + failed++.
- CLI entrypoint (pathToFileURL guard): builds `[makeClaudeMemSource(), makeClaudeCodeSource()]`, `sinceDays = Number(process.env.SESSIONS_SINCE_DAYS ?? 30)`, prints the JSON result.

- [ ] **Step 1:** Write `tests/session-ingest.test.ts`:

```ts
import { expect, test } from "vitest";
import { ingestSessions } from "../src/ingest/sessions/cli.js";
import { searchKnowledge } from "../src/services/knowledge.js";
import { FakeEmbedder } from "../src/knowledge/embedder.js";
import type { SessionSource } from "../src/ingest/sessions/source.js";

const emb = new FakeEmbedder(1024);

test("ingest is hash-gated and retrievable; failures isolated", async () => {
  const uniq = `sess-${Date.now()}-${Math.round(performance.now() * 1000)}`;
  const doc = { ref: `fake#${uniq}`, text: `decided to use pglite ${uniq}`, hash: `h-${uniq}` };
  const good: SessionSource = { source: "fake", listSessionDocs: async () => [doc] };
  const bad: SessionSource = { source: "boom", listSessionDocs: async () => { throw new Error("down"); } };

  const r1 = await ingestSessions([good, bad], emb, 30);
  expect(r1.fake.indexed).toBe(1);
  expect(r1.boom.failed).toBe(1);

  const r2 = await ingestSessions([good], emb, 30); // unchanged hash -> skipped
  expect(r2.fake.skipped).toBe(1);
  expect(r2.fake.indexed).toBe(0);

  const hits = await searchKnowledge(doc.text, { limit: 5 }, emb);
  expect(hits.some((h) => h.sourceRef === doc.ref && h.sourceKind === "session")).toBe(true);
});
```

- [ ] **Step 2:** Confirm FAIL, then write `cli.ts`:

```ts
import { pathToFileURL } from "node:url";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { embeddings } from "../../db/schema.js";
import { upsertSourceDoc } from "../../services/knowledge.js";
import { getEmbedder, type Embedder } from "../../knowledge/embedder.js";
import { makeClaudeMemSource } from "./claude-mem.js";
import { makeClaudeCodeSource } from "./claude-code.js";
import type { SessionSource } from "./source.js";

export async function ingestSessions(
  sources: SessionSource[],
  embedder: Embedder = getEmbedder(),
  sinceDays = 30,
): Promise<Record<string, { indexed: number; skipped: number; failed: number }>> {
  const result: Record<string, { indexed: number; skipped: number; failed: number }> = {};
  for (const src of sources) {
    const r = { indexed: 0, skipped: 0, failed: 0 };
    result[src.source] = r;
    let docs;
    try { docs = await src.listSessionDocs(sinceDays); }
    catch (e) { console.warn(`source ${src.source} failed: ${(e as Error).message}`); r.failed++; continue; }
    for (const doc of docs) {
      try {
        const [existing] = await db.select({ h: embeddings.contentHash }).from(embeddings)
          .where(and(eq(embeddings.sourceKind, "session"), eq(embeddings.sourceRef, doc.ref))).limit(1);
        if (existing && existing.h === doc.hash) { r.skipped++; continue; }
        await upsertSourceDoc("session", doc.ref, doc.text, embedder, doc.hash);
        r.indexed++;
      } catch (e) {
        console.warn(`doc ${doc.ref} failed: ${(e as Error).message}`);
        r.failed++;
      }
    }
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sinceDays = Number(process.env.SESSIONS_SINCE_DAYS ?? 30);
  const result = await ingestSessions([makeClaudeMemSource(), makeClaudeCodeSource()], getEmbedder(), sinceDays);
  console.log(JSON.stringify(result));
}
```

- [ ] **Step 3:** Add `"ingest:sessions": "tsx src/ingest/sessions/cli.ts"` to package.json scripts.
- [ ] **Step 4:** README: short "Session memory (cross-tool history)" section under Knowledge ingestion — what it ingests (claude-mem observations + Claude Code transcripts, last 30 days by default, `SESSIONS_SINCE_DAYS` to widen), rerun-safe, and the privacy note (indexes conversation text into the local DB; tool outputs are stripped but pasted secrets in messages may be indexed).
- [ ] **Step 5:** `npm test -- session-ingest`, FULL `npm test`, `npm run typecheck`. Commit: `feat: session ingest cli with hash gating and cross-tool retrieval`.

---

## Acceptance

- All new tests + full suite + typecheck green; vault/PDF tests unchanged (wrapper regression net).
- LIVE (controller-run): `EMBED_PROVIDER=fake npm run ingest:sessions` on this machine ingests real claude-mem observations + recent transcripts; re-run reports skips; a `search_knowledge` query about recent VibeOps work returns a session chunk with a `claude-mem#<id>` or transcript-path citation.

## Self-review notes (done)

- Spec coverage: interface+two readers (T2,T3), enum+generalized upsert (T1), CLI+window+hash-gate (T4), retrieval untouched, privacy note in README (T4), error isolation per doc/source (T4/T2/T3). Covered.
- Type consistency: `SessionDoc {ref,text,hash}`, `listSessionDocs(sinceDays)`, `upsertSourceDoc(kind,ref,text,embedder,hash?)`, `ingestSessions(sources,embedder?,sinceDays?)` identical across tasks/tests.
- Latitude flagged: drizzle-kit's enum-add migration shape (T1 Step 2 — inspect + note); node:sqlite `readOnly` option name (if the installed Node's option differs, adjust and note); `created_at_epoch` ms semantics pinned by fixture.
- Ponytail: no live watcher, no redaction engine, no per-tool registry — two readers + one loop.
