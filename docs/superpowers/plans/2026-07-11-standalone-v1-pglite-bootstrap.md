# Standalone v1 — Embedded PGlite + Auto-Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** VibeOps runs with zero external dependencies: no `DATABASE_URL` → an embedded PGlite database (pgvector included) in `~/.vibeops/data`, migrations applied at boot, first run self-creates the Inbox project + owner actor and writes `~/.vibeops/credentials.json`, and the desktop app auto-detects those credentials. `DATABASE_URL` set → today's Postgres path, byte-identical; the whole existing test suite stays on real Postgres.

**Architecture:** `src/db/client.ts` becomes the single driver seam (postgres-js | PGlite) chosen by env; raw postgres-js usage in `searchKnowledge`/`vector-setup` moves to Drizzle's driver-agnostic `sql` via `db.execute` (with a rows-normalization shim — the two drivers return different shapes); drizzle-kit-generated SQL migrations are committed and run programmatically on embedded boot; `src/bootstrap.ts` runs after migrations in embedded mode only; the app reads `credentials.json` through a tightly-scoped `plugin-fs` capability.

**Tech Stack:** `@electric-sql/pglite` (+ its `/vector` extension), `drizzle-orm/pglite` + `drizzle-orm/pglite/migrator` (present in installed drizzle-orm 0.36.4), drizzle-kit `generate`, `@tauri-apps/plugin-fs` 2.

**Spec:** `docs/superpowers/specs/2026-07-11-standalone-v1-pglite-bootstrap-design.md`

## Global Constraints

- Node ESM (`.js` imports). Existing 39-test suite MUST keep running against real Postgres :5433 — the seam selects postgres-js whenever `DATABASE_URL` is set OR `process.env.VITEST` is truthy. PGlite only when neither (real standalone runtime).
- postgres-js connects lazily, so the `sql` export may keep existing unconditionally — after this slice no runtime code path uses it in embedded mode (only tests + external-mode scripts).
- Embedded data dir: `join(homedir(), ".vibeops", "data")`. Credentials: `join(homedir(), ".vibeops", "credentials.json")` — plaintext key lives ONLY there; DB stores the hash (unchanged).
- Bootstrap runs ONLY in embedded mode and ONLY in the API server process (not MCP/watcher/sync). Idempotent: actors table non-empty → skip.
- HNSW index failure under PGlite → warn once, continue (never fail boot).
- Migrations additive-only from now on. `drizzle-kit generate` output (`drizzle/`) is committed.
- App fs capability scoped to exactly `$HOME/.vibeops/*` — no broad fs access. Missing/unreadable credentials → fall through to manual Settings, never crash.
- No emojis; minimal comments/logs. Ponytail: no db-injection refactor of services — embedded plumbing is tested via a direct PGlite instance; bootstrap logic is tested on real PG (identical code path).
- The user owns the frontend look; Task 4 wires logic into the EXISTING `LocalNodeTab` (`app/src/components/settings/LocalNodeTab.tsx`) without restyling it.

## File Structure

- `drizzle/` — NEW: committed SQL migrations (drizzle-kit generate).
- `src/db/client.ts` — driver seam + embedded init (TLA) + `isEmbedded` export.
- `src/db/vector-setup.ts` — `db.execute` versions; tolerant `ensureIndex`.
- `src/services/knowledge.ts` — `searchKnowledge` raw query → `db.execute(sql\`...\`)` + rows shim.
- `src/bootstrap.ts` — NEW: `runBootstrap(port, dir?)`.
- `src/api/server.ts` — call bootstrap when embedded.
- `package.json` — `@electric-sql/pglite`, `db:generate` script.
- `app/` — plugin-fs (npm + Cargo + lib.rs + capability), `detectLocalNode()` in `settings.ts`, button in `LocalNodeTab`, auto-detect in `main.tsx` gate, identifier → `com.vibeops.app`.
- `tests/` — `embedded-db.test.ts`, `bootstrap.test.ts`.

---

### Task 1: Migrations + driver seam

**Files:**
- Modify: `package.json`, `src/db/client.ts`
- Create: `drizzle/` (generated), `tests/embedded-db.test.ts`

**Interfaces:**
- `client.ts` exports (unchanged names): `db`, `sql`, plus NEW `isEmbedded: boolean`.

- [ ] **Step 1: Add dep + script; generate migrations**

`npm install @electric-sql/pglite` (accept installed major; if drizzle-orm 0.36's pglite driver rejects the PGlite instance type, pin `@electric-sql/pglite@^0.2` and NOTE it). Add script `"db:generate": "drizzle-kit generate"`. Run `npm run db:generate` — produces `drizzle/0000_*.sql` + `drizzle/meta/` from the current schema (generate is offline; ignore dbCredentials). Inspect the SQL: it must contain the `vector(1024)` column and all 9 tables + CHECK + unique indexes. Commit the folder.

- [ ] **Step 2: Rewrite `src/db/client.ts`**

```ts
import { join } from "node:path";
import { homedir } from "node:os";
import postgres from "postgres";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

// Driver seam: DATABASE_URL -> postgres-js; vitest -> postgres-js fallback (the
// suite stays on real Postgres); otherwise embedded PGlite in ~/.vibeops/data.
const url = process.env.DATABASE_URL;
export const isEmbedded = !url && !process.env.VITEST;

// postgres-js connects lazily, so creating it unconditionally is harmless in
// embedded mode (no runtime code path uses `sql` there after this slice).
export const sql = postgres(url ?? "postgres://tickets:tickets@localhost:5433/tickets");

async function makeDb() {
  if (!isEmbedded) return drizzlePg(sql, { schema });
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite(join(homedir(), ".vibeops", "data"), { extensions: { vector } });
  await client.exec("CREATE EXTENSION IF NOT EXISTS vector");
  const d = drizzlePglite(client as never, { schema });
  await migrate(d as never, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") });
  return d;
}

export const db = (await makeDb()) as ReturnType<typeof drizzlePg<typeof schema>>;
```
Notes for the implementer: the `migrationsFolder` must resolve to the repo's `drizzle/` dir on Windows — the URL/pathname dance above strips the leading slash from `/D:/...`; if it misbehaves, use `fileURLToPath(new URL("../../drizzle", import.meta.url))` from `node:url` (preferred — use it if it typechecks, it is the cleaner form). The `as never`/return-type cast unifies the two drizzle driver types — both expose the same query API surface used by the services; do not fork service code. Top-level await is fine (ESM, tsx, Node 24).

- [ ] **Step 3: Write `tests/embedded-db.test.ts`** (direct PGlite instance — does NOT use the global client; the global stays on real PG under vitest)

```ts
import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("migrations + vector round-trip work on PGlite", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const dir = mkdtempSync(join(tmpdir(), "vibeops-pglite-"));
  const client = new PGlite(dir, { extensions: { vector } });
  await client.exec("CREATE EXTENSION IF NOT EXISTS vector");
  const d = drizzle(client as never);
  await migrate(d as never, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });

  const tables = await client.query(
    "select table_name from information_schema.tables where table_schema='public'");
  const names = (tables.rows as { table_name: string }[]).map((r) => r.table_name);
  for (const t of ["projects", "actors", "tickets", "comments", "events", "notes", "embeddings", "sync_links", "sync_comment_links"]) {
    expect(names).toContain(t);
  }

  // vector round-trip: insert an embedding row and cosine-query it back
  await client.query("insert into projects (key, name) values ('p','P')");
  const vec = `[${Array.from({ length: 1024 }, (_, i) => (i % 7) / 7).join(",")}]`;
  await client.query(
    `insert into embeddings (source_kind, source_ref, chunk_index, content, embedding, model, dim, content_hash)
     values ('vault','f.md',0,'hello', $1::vector,'fake',1024,'h')`, [vec]);
  const hit = await client.query(
    `select content, 1 - (embedding <=> $1::vector) as score from embeddings
     where dim = 1024 order by embedding <=> $1::vector limit 1`, [vec]);
  expect((hit.rows as { content: string; score: number }[])[0].content).toBe("hello");

  await client.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 4: Run**

`npm test -- embedded-db` (proves migrations + pgvector under WASM), then FULL `npm test` (the 39 existing tests must be untouched — they run postgres-js via the VITEST guard), then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: embedded pglite driver seam with committed migrations"
```

---

### Task 2: Raw-SQL refactor (knowledge + vector-setup)

**Files:**
- Modify: `src/services/knowledge.ts`, `src/db/vector-setup.ts`

**Interfaces:** unchanged signatures (`searchKnowledge`, `ensureExtension`, `ensureIndex`).

- [ ] **Step 1: Refactor `searchKnowledge` in `src/services/knowledge.ts`**

Replace the `rawSql` tagged-template query with Drizzle's driver-agnostic `sql` via `db.execute`, keeping the exact same SQL semantics (`::vector` cast on a bound param, `dim` filter in WHERE, cosine order, limit):

```ts
import { sql as dsql } from "drizzle-orm";
// inside searchKnowledge, replacing the rawSql`...` call:
const res: unknown = await db.execute(dsql`
  select source_kind, source_ref, content,
         1 - (embedding <=> ${lit}::vector) as score
  from embeddings
  where dim = ${embedder.dim}
  order by embedding <=> ${lit}::vector
  limit ${limit}`);
// postgres-js execute returns an array-like; pglite returns { rows }. Normalize:
const rows = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as any[];
```
Drop the `sql as rawSql` import from `../db/client.js` if nothing else in the file uses it. Mapping of `rows` to the return shape stays identical.

- [ ] **Step 2: Refactor `src/db/vector-setup.ts`**

```ts
import { sql as dsql } from "drizzle-orm";
import { db } from "./client.js";

export async function ensureExtension(): Promise<void> {
  await db.execute(dsql`CREATE EXTENSION IF NOT EXISTS vector`);
}

export async function ensureIndex(): Promise<void> {
  try {
    await db.execute(dsql`CREATE INDEX IF NOT EXISTS embeddings_embedding_idx
      ON embeddings USING hnsw (embedding vector_cosine_ops)`);
  } catch (e) {
    console.warn("hnsw index unavailable; continuing unindexed:", (e as Error).message);
  }
}
```

- [ ] **Step 3: Run**

`npm test -- knowledge-search` and `npm test -- e2e-memory` (the vector query consumers), then FULL `npm test`, then `npm run typecheck`. All green on real PG proves the refactor didn't change semantics; Task 1's embedded test already proved the same SQL shape works on PGlite.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor: driver-agnostic vector queries via db.execute"
```

---

### Task 3: Auto-bootstrap + server wiring

**Files:**
- Create: `src/bootstrap.ts`, `tests/bootstrap.test.ts`
- Modify: `src/api/server.ts`

**Interfaces:**
- `runBootstrap(port: number, dir?: string): Promise<{ bootstrapped: boolean }>` — `dir` defaults to `join(homedir(), ".vibeops")`; parameterized so the test writes a temp dir.

- [ ] **Step 1: Write `tests/bootstrap.test.ts`** (logic runs on real PG under vitest — identical code path)

```ts
import { expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBootstrap } from "../src/bootstrap.js";

test("bootstrap creates credentials once and is idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibeops-boot-"));
  const first = await runBootstrap(8787, dir);
  // On a shared dev DB actors may already exist; assert on the return contract:
  if (first.bootstrapped) {
    const creds = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"));
    expect(creds.baseUrl).toBe("http://localhost:8787");
    expect(creds.apiKey.length).toBeGreaterThan(20);
  }
  const second = await runBootstrap(8787, dir);
  expect(second.bootstrapped).toBe(false); // actors now exist -> always skips
  rmSync(dir, { recursive: true, force: true });
});
```
Note: the dev DB already has actors, so `first.bootstrapped` will be false there — the test's hard guarantee is idempotency (second run always false) and the file contract when it does write. The embedded first-run path is covered by manual acceptance.

- [ ] **Step 2: Run to verify it fails** (`npm test -- bootstrap` → module missing)

- [ ] **Step 3: Write `src/bootstrap.ts`**

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { db } from "./db/client.js";
import { actors } from "./db/schema.js";
import { createActor } from "./services/actors.js";
import { createProject } from "./services/projects.js";

// First-run self-setup for the embedded database. Idempotent: any existing
// actor means the system is already initialized.
export async function runBootstrap(
  port: number, dir = join(homedir(), ".vibeops"),
): Promise<{ bootstrapped: boolean }> {
  const [existing] = await db.select({ id: actors.id }).from(actors).limit(1);
  if (existing) return { bootstrapped: false };

  await createProject({ key: "inbox", name: "Inbox" });
  const { apiKey } = await createActor({ name: "owner", kind: "human", role: "admin" });
  const creds = { baseUrl: `http://localhost:${port}`, apiKey };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "credentials.json"), JSON.stringify(creds, null, 2));
  } catch (e) {
    console.warn(`could not write credentials file: ${(e as Error).message}`);
    console.log(`api key (copy now, shown once): ${apiKey}`);
  }
  return { bootstrapped: true };
}
```

- [ ] **Step 4: Wire into `src/api/server.ts`**

```ts
import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { isEmbedded } from "../db/client.js";
import { runBootstrap } from "../bootstrap.js";
import { ensureIndex } from "../db/vector-setup.js";

const port = Number(process.env.PORT ?? 8787);
if (isEmbedded) {
  await ensureIndex();               // tolerant: warns + continues without hnsw
  const { bootstrapped } = await runBootstrap(port);
  if (bootstrapped) console.log("first run: created Inbox project + owner key -> ~/.vibeops/credentials.json");
} else if (!process.env.DATABASE_URL) {
  // unreachable in practice (isEmbedded covers it), kept for clarity
} 
serve({ fetch: app.fetch, port });
console.log(`api on :${port}${isEmbedded ? " (embedded db)" : ""}`);
```
(Implementer: drop the empty else-if — it is noise; shown here only to say external mode gets NO bootstrap. Final code: `if (isEmbedded) { ... }` then `serve`.)

- [ ] **Step 5: Run**

`npm test -- bootstrap`, FULL `npm test`, `npm run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: first-run auto-bootstrap writing ~/.vibeops/credentials.json"
```

---

### Task 4: App — detect local node + identifier rename

**Files:**
- Modify: `app/package.json`, `app/src-tauri/Cargo.toml`, `app/src-tauri/src/lib.rs`, `app/src-tauri/capabilities/default.json`, `app/src-tauri/tauri.conf.json`, `app/src/settings.ts`, `app/src/components/settings/LocalNodeTab.tsx`, `app/src/main.tsx`
- Create: `app/src/detect.test.ts`

**Interfaces:**
- `settings.ts` gains `detectLocalNode(): Promise<Settings | null>` (+ `setReadTextFileImpl(fn)` test seam).

- [ ] **Step 1: Install plugin-fs**

In `app/`: `npm install @tauri-apps/plugin-fs`. In `app/src-tauri/Cargo.toml`: `tauri-plugin-fs = "2"`. In `lib.rs` builder chain: `.plugin(tauri_plugin_fs::init())`.

- [ ] **Step 2: Capability — scoped to `.vibeops` only** (`app/src-tauri/capabilities/default.json`, add to permissions)

```json
{
  "identifier": "fs:allow-read-text-file",
  "allow": [{ "path": "$HOME/.vibeops/*" }]
}
```

- [ ] **Step 3: Add `detectLocalNode` to `app/src/settings.ts`**

```ts
import { readTextFile, BaseDirectory } from "@tauri-apps/plugin-fs";

type ReadImpl = (path: string, opts: { baseDir: number }) => Promise<string>;
let readImpl: ReadImpl = readTextFile as unknown as ReadImpl;
export function setReadTextFileImpl(fn: ReadImpl) { readImpl = fn; }

// Read server-written first-run credentials; null when absent/unreadable/malformed.
export async function detectLocalNode(): Promise<Settings | null> {
  try {
    const raw = await readImpl(".vibeops/credentials.json", { baseDir: BaseDirectory.Home });
    const parsed = JSON.parse(raw);
    if (typeof parsed.baseUrl !== "string" || typeof parsed.apiKey !== "string" || !parsed.apiKey) return null;
    return { baseUrl: parsed.baseUrl, apiKey: parsed.apiKey };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Wire into the existing UI + gate (do not restyle)**

- `LocalNodeTab.tsx`: add a "Detect local node" button beside the existing Test/Save controls: `const found = await detectLocalNode(); if (found) { setBaseUrl(found.baseUrl); setApiKey(found.apiKey); await saveSettings(found); test(); } else setStatus("bad");` — reuse the tab's existing status rendering; match its existing styles/classes.
- `main.tsx` root `beforeLoad`: before redirecting to `/settings` when apiKey is empty, try `const found = await detectLocalNode(); if (found) { await saveSettings(found); return; }` — only redirect when detection fails.

- [ ] **Step 5: Rename identifier** in `app/src-tauri/tauri.conf.json`: `"identifier": "com.vibeops.app"`. NOTE: this moves the plugin-store path (old `%APPDATA%\com.admin.app` settings are orphaned) — acceptable now; auto-detect refills credentials on next launch.

- [ ] **Step 6: Write `app/src/detect.test.ts`**

```ts
import { expect, test } from "vitest";
import { detectLocalNode, setReadTextFileImpl } from "./settings.js";

test("detectLocalNode parses credentials and rejects malformed", async () => {
  setReadTextFileImpl(async () => JSON.stringify({ baseUrl: "http://localhost:8787", apiKey: "k".repeat(48) }));
  expect(await detectLocalNode()).toEqual({ baseUrl: "http://localhost:8787", apiKey: "k".repeat(48) });
  setReadTextFileImpl(async () => "not json");
  expect(await detectLocalNode()).toBeNull();
  setReadTextFileImpl(async () => { throw new Error("missing"); });
  expect(await detectLocalNode()).toBeNull();
});
```
If importing `settings.ts` in jsdom pulls the real `@tauri-apps/plugin-fs` and fails at import time, mock the module with `vi.mock("@tauri-apps/plugin-fs", () => ({ readTextFile: vi.fn(), BaseDirectory: { Home: 11 } }))` at the top and note it.

- [ ] **Step 7: Run**

In `app/`: `npm test` (all existing app tests + new), `npx tsc --noEmit`, `npm run build`; `cargo check` in `src-tauri` if cargo available (`export PATH="$HOME/.cargo/bin:$PATH"`).

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: auto-detect local node credentials via scoped fs capability"
```

---

### Task 5: Docs

**Files:**
- Modify: `ARCH.md`, `README.md`

- [ ] **Step 1:** README quickstart gets the standalone path first: `npm install && npm run dev` (no Docker, no env) → boots embedded DB in `~/.vibeops/data`, first run prints + writes credentials; app auto-connects. Keep the external-Postgres path as the "advanced/server deploy" section (Docker instructions unchanged). Document factory reset (delete `~/.vibeops/data`) and that `credentials.json` holds the plaintext key.
- [ ] **Step 2:** ARCH.md: add PGlite to components/deps, `.vibeops` layout, the driver-seam selection rule (`DATABASE_URL` → postgres; `VITEST` → postgres :5433; else embedded), bootstrap behavior, `db:generate` script, migrations-additive-only rule.
- [ ] **Step 3:** Commit: `git add -A && git commit -m "docs: standalone quickstart and embedded-db architecture"`.

---

## Acceptance

- Docker stopped, no `DATABASE_URL`: `npm run dev` → migrates, bootstraps, writes `~/.vibeops/credentials.json`, serves on :8787; fresh app launch auto-connects (no manual entry); create ticket + save note + `search_knowledge` round-trip works on the embedded DB. Second boot: `bootstrapped: false`, no duplicates.
- `DATABASE_URL` set: identical to today; FULL server suite (39+new) green on :5433; app suite green.
- Deleting `~/.vibeops/data` factory-resets; next boot re-migrates + re-bootstraps.

## Self-review notes (done)

- Spec coverage: dual-mode seam w/ VITEST guard (T1), raw-SQL→db.execute with rows shim (T2), migrations committed + run at boot (T1), tolerant hnsw (T2/T3 wiring), bootstrap idempotent + credentials contract (T3), scoped fs capability + detect + auto-gate + identifier rename (T4), docs incl. factory reset (T5). Covered.
- Honest test boundaries stated: embedded e2e-with-services is manual acceptance (services bind the global db; no injection refactor — ponytail); embedded plumbing proven via direct PGlite test; bootstrap logic proven on real PG.
- Flagged latitude: PGlite@^0.5 vs drizzle-0.36 type fit (pin ^0.2 fallback, note it); Windows migrationsFolder path (prefer `fileURLToPath`); jsdom import of plugin-fs may need `vi.mock`.
- Type consistency: `isEmbedded`, `runBootstrap(port, dir?)`, `detectLocalNode()`, `setReadTextFileImpl(fn)` used identically across tasks and tests.

---

## Queued next slice (own spec/plan cycle — NOT part of this plan): cross-tool session memory

Problem: work done in Gemini/Codex/Antigravity/local LLMs is invisible to later sessions in other tools. claude-mem cannot solve this (it is Claude-Code-only). Solution direction: a session-transcript ingestion connector in the existing knowledge layer — tail each tool's local session logs (Claude Code `~/.claude/projects/**/*.jsonl`, Codex `~/.codex/sessions`, Gemini CLI `~/.gemini`, Antigravity, local-LLM chat exports), parse per-tool, chunk + embed into `embeddings` under a new `session` sourceKind (schema enum extension), hash-gated like the vault watcher, citations = tool + session file. Every MCP-connected tool then shares one queryable cross-tool history via `search_knowledge`. Per-tool parsers are the per-connector work; log locations/formats must be verified per tool at design time.
