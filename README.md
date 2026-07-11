# VibeOps

A self-hosted ticketing engine with a built-in knowledge/RAG layer, reachable over REST and MCP so both humans and AI agents (Claude Code/Cowork, Gemini, Codex, Cursor) share one audited source of truth.

- **Postgres** owns all ticket state, workflow, and an append-only audit trail — real transactions, optimistic concurrency (per-actor `version` locking), and per-actor API-key auth.
- **pgvector** holds a rebuildable knowledge index: the Obsidian vault (markdown and PDF) plus writeable "memory" notes, searchable via one `search_knowledge` tool.
- **One service layer** backs both a REST API and an MCP server, so every mutation — from a human in the desktop app or an AI agent over MCP — lands in the same audit trail.
- A **Tauri desktop app** (`app/`) is a pure client over the REST API.

## Prerequisites

- Node 20+ and npm
- Docker (Postgres 16 + pgvector runs in a container)
- **Java 11+** — only if you want PDF ingestion (see below). Not needed otherwise.

## Quick start

```bash
npm install
npm run db:vector        # create the pgvector extension (must run before db:push)
npm run db:up            # start Postgres (pgvector/pgvector:pg16) on host port 5433
npm run db:push          # create the schema
npm run db:vector:index  # create the hnsw vector index
npm run dev              # REST API on :8787
```

Copy `.env.example` to `.env` first. Postgres listens on host port **5433** (5432 is often taken by a native install).

- `npm run mcp` — start the MCP server (set `TICKETS_API_KEY`); register it in Claude Code and drive tickets/knowledge as tools.
- `npm run ingest:watch` — watch the Obsidian vault and index it into pgvector (set `VAULT_PATH`, `EMBED_PROVIDER`, and the provider key; `EMBED_PROVIDER=fake` for a no-network dry run).
- `npm test` — server test suite (needs the DB up). The desktop app has its own suite under `app/`.

## Knowledge ingestion

The vault watcher indexes both `.md` and `.pdf` files. Each file is chunked, embedded, and stored in pgvector with the file path as its citation; unchanged files are hash-gated and skipped on re-index, and deleting a file removes it from the index.

### PDF ingestion (requires Java 11+)

PDF files are converted to markdown with [`@opendataloader/pdf`](https://github.com/opendataloader-project/opendataloader-pdf), which runs on the JVM. To ingest PDFs, install a JDK 11+ (e.g. from [Adoptium](https://adoptium.net/)) on the machine running `npm run ingest:watch`.

- Without a JVM, PDFs are skipped (with one startup warning) and markdown ingestion continues unaffected.
- Each PDF conversion spawns a JVM process (slow), so unchanged PDFs are hash-gated on their raw bytes and skipped — only new or edited PDFs are re-converted.

Conversion runs in local (deterministic) mode. Hybrid/OCR mode, JSON-with-bounding-boxes output, and PDF/UA accessibility export are out of scope for this integration.

## Graphify (agent-side knowledge graph)

[Graphify](https://github.com/Graphify-Labs/graphify) (MIT) is an AI-assistant skill that turns a folder of code, schemas, docs, and papers into a queryable knowledge graph (GraphRAG, tree-sitter, Leiden clustering). It complements this server's `search_knowledge`:

- **`search_knowledge`** (pgvector) — semantic similarity: "find docs about X".
- **Graphify** — entity/relationship traversal: "what depends on X", "how does A connect to B".

Graphify runs entirely on the agent machine (Claude Code / Codex / Gemini / Cursor). Install it there and point it at the Obsidian vault and this repo. The tickets server neither depends on nor invokes it — it is a parallel, agent-side capability. Evaluate its licensing and fit before relying on it in a workflow.
