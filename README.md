# VibeOps

A self-hosted ticketing engine with a built-in knowledge/RAG layer, reachable over REST and MCP so both humans and AI agents (Claude Code/Cowork, Gemini, Codex, Cursor) share one audited source of truth.

- **Postgres** owns all ticket state, workflow, and an append-only audit trail — real transactions, optimistic concurrency (per-actor `version` locking), and per-actor API-key auth.
- **pgvector** holds a rebuildable knowledge index: the Obsidian vault (markdown and PDF) plus writeable "memory" notes, searchable via one `search_knowledge` tool.
- **One service layer** backs both a REST API and an MCP server, so every mutation — from a human in the desktop app or an AI agent over MCP — lands in the same audit trail.
- A **Tauri desktop app** (`app/`) is a pure client over the REST API.

## Install (one file)

Build the installer once (`npm run build:sidecar`, then `npm run tauri build` in `app/` — requires Rust; delete `app/src-tauri/resources/node` before a release build to force a fresh, checksum-verified Node download) and you get a single artifact per platform (NSIS `.exe` on Windows; `deb`/`AppImage` config on Linux). Installing and launching VibeOps:

- The app spawns its own bundled server (portable Node + embedded database) on `127.0.0.1:8787` — unless something is already serving there (a dev server or another VibeOps instance), in which case it attaches instead of double-spawning.
- First launch self-creates the Inbox project, an owner API key, and `~/.vibeops/credentials.json`; the app auto-connects.
- Quitting the app stops the bundled server. A force-kill (Task Manager) can leave the server running; the next launch attaches to it instead of double-spawning. Data lives in `~/.vibeops` and is never touched by install or uninstall — backup/restore rules below apply unchanged.
- Linux: the server payload is verified on Ubuntu (x64); deb/AppImage bundle configs are included. macOS config exists but is unverified.

## Prerequisites (running from source)

- Node 20+ and npm

**For standalone mode** — no additional prerequisites. The embedded database runs on first boot.

**For Docker/Postgres mode** — Docker (Postgres 16 + pgvector) and optionally Java 11+ for PDF ingestion.

## Quick start (standalone)

```bash
npm install
npm run dev              # REST API on :8787
```

On first run, VibeOps boots an embedded PGlite database (pgvector included) in `~/.vibeops/data`, runs migrations from `drizzle/`, and creates an Inbox project with an owner actor. API credentials are written to `~/.vibeops/credentials.json` (mode 0600); the desktop app auto-detects them.

No Docker, no environment variables, no setup — just run `npm run dev`.

- `npm run mcp` — start the MCP server; the app uses credentials from `~/.vibeops/credentials.json`.
- `npm run ingest:watch` — watch the Obsidian vault and index it (set `VAULT_PATH` at minimum; embedding uses a local model by default, or set `EMBED_PROVIDER` and its key for API-based embeddings; use `EMBED_PROVIDER=fake` for a no-network dry run).
- `npm test` — server test suite. The desktop app has its own suite under `app/`.

### Factory reset

Delete `~/.vibeops/data`:

```bash
rm -rf ~/.vibeops/data
```

On next `npm run dev`, the embedded database re-migrates and re-bootstraps (Inbox project + owner actor).

### Backup & restore

`~/.vibeops` is the single backup unit — database, credentials, and configuration live there.

**Backup:** Copy the folder.
```bash
cp -r ~/.vibeops ~/backup-vibeops
```

**Restore:** Copy the folder onto a fresh machine BEFORE first run.
```bash
cp -r ~/backup-vibeops ~/.vibeops
npm run dev
```

On boot, the app detects existing actors and skips bootstrap. Credentials are restored and auto-detected by the desktop app. Treat `~/.vibeops/credentials.json` like `~/.ssh` — it holds the plaintext API key.

## Connect an agent (MCP)

The sidecar serves MCP over streamable HTTP at `http://127.0.0.1:8787/mcp`, authenticated with the same API key as the REST API.

The desktop app's MCP card (Settings) is the one-click path: Cursor and Gemini get their config file written automatically — any existing file is preserved as `<path>.vibeops-backup` before it's overwritten. Claude Code has no config file to write to, so the card instead gives you a `claude mcp add` command to copy and run.

For scripting or a custom client, the same two endpoints back the card: `GET /mcp/config` returns the URL plus a ready-to-run command/snippet per client, and `POST /mcp/install` (`{ "client": "cursor" | "gemini" }`) performs the write.

The legacy stdio server (`npm run mcp`) still works and remains the right choice for external-Postgres setups where the client runs on a different machine than the server.

Note: installed client configs hold the API key in plaintext, same trust level as `~/.vibeops/credentials.json` — treat them accordingly.

## Advanced: external Postgres

To use an external Postgres database (recommended for production), set `DATABASE_URL`:

```bash
export DATABASE_URL="postgresql://user:password@localhost:5433/vibeops"
npm run db:vector        # create the pgvector extension (must run before db:push)
npm run db:push          # create the schema
npm run db:vector:index  # create the hnsw vector index
npm run dev              # REST API on :8787
```

Copy `.env.example` to `.env` first. Postgres listens on host port **5433** (5432 is often taken by a native install).

In external mode, the database does not auto-bootstrap — ensure you run the schema and index setup steps before starting the server. To reset, drop and recreate the schema.

## Architecture

**Database driver seam:** The server detects which database to use at boot:

- `DATABASE_URL` is set → Postgres (external mode; respects `VITEST` for test suite via `:5433`)
- `VITEST` is set (no `DATABASE_URL`) → Postgres at localhost:5433 (test suite)
- Otherwise → PGlite embedded database in `~/.vibeops/data` (standalone mode)

**Schema management:** Run `npm run db:generate` before adding migrations. The script runs `drizzle-kit generate` and outputs migration files to `drizzle/`. Migrations are additive-only — rollbacks are not supported.

**PGlite version:** `@electric-sql/pglite` is pinned to `^0.2.x`. Version `0.5.x` and later split the vector extension into a separate package (`@electric-sql/pglite-vector`); stay on `0.2.x` for the bundled vector support.

## Knowledge ingestion

The vault watcher indexes both `.md` and `.pdf` files. Each file is chunked, embedded, and stored in pgvector with the file path as its citation; unchanged files are hash-gated and skipped on re-index, and deleting a file removes it from the index.

Knowledge search works with **no API key required by default**. When neither `EMBED_PROVIDER` nor `VOYAGE_API_KEY` is set, VibeOps uses a local embedding model (`all-MiniLM-L6-v2`, quantized ONNX via transformers.js) running entirely in-process. On first use, the model (~23 MB) downloads from the Hugging Face hub and caches in `~/.vibeops/models`; subsequent embedding operations work offline. While the initial download completes, embedding calls fail gracefully — notes remain unindexed and are swept on re-run. To opt into API-grade quality, set `VOYAGE_API_KEY` (Voyage is used automatically) or explicitly choose an `EMBED_PROVIDER`; explicit provider choice always takes precedence. Switching providers makes any notes embedded with the previous provider invisible to search (search filters by embedding dimension); migrate by re-ingesting. The `~/.vibeops/models` directory is part of the single backup unit and safe to delete — the model simply re-downloads on next run.

### PDF ingestion (requires Java 11+)

PDF files are converted to markdown with [`@opendataloader/pdf`](https://github.com/opendataloader-project/opendataloader-pdf), which runs on the JVM. To ingest PDFs, install a JDK 11+ (e.g. from [Adoptium](https://adoptium.net/)) on the machine running `npm run ingest:watch`.

- Without a JVM, PDFs are skipped (with one startup warning) and markdown ingestion continues unaffected.
- Each PDF conversion spawns a JVM process (slow), so unchanged PDFs are hash-gated on their raw bytes and skipped — only new or edited PDFs are re-converted.

Conversion runs in local (deterministic) mode. Hybrid/OCR mode, JSON-with-bounding-boxes output, and PDF/UA accessibility export are out of scope for this integration.

### Session memory (cross-tool history)

Session ingestion indexes Claude Code transcripts and claude-mem observations into the knowledge base, making recent project context searchable across any connected tool. Run `npm run ingest:sessions` to ingest the last 30 days (or set `SESSIONS_SINCE_DAYS` to widen the window); re-runs are safe and skip unchanged sessions via content hash-gating. Indexed sessions are searchable via `search_knowledge` from any connected MCP client.

Note: Session ingestion stores conversation text in the local knowledge database; tool output blocks are stripped before indexing, but secrets pasted directly into messages may be indexed. Run with `EMBED_PROVIDER=fake` for a dry run without embedding costs.

## Graphify (agent-side knowledge graph)

[Graphify](https://github.com/Graphify-Labs/graphify) (MIT) is an AI-assistant skill that turns a folder of code, schemas, docs, and papers into a queryable knowledge graph (GraphRAG, tree-sitter, Leiden clustering). It complements this server's `search_knowledge`:

- **`search_knowledge`** (pgvector) — semantic similarity: "find docs about X".
- **Graphify** — entity/relationship traversal: "what depends on X", "how does A connect to B".

Graphify runs entirely on the agent machine (Claude Code / Codex / Gemini / Cursor). Install it there and point it at the Obsidian vault and this repo. The tickets server neither depends on nor invokes it — it is a parallel, agent-side capability. Evaluate its licensing and fit before relying on it in a workflow.
