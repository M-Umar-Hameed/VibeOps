# ARCH — Architecture & Requirements

Self-hosted ticketing engine + knowledge/RAG layer + desktop client, reachable over REST and MCP so humans and AI agents share one audited source of truth. Built in phases: Postgres ticket engine (1) → pgvector knowledge/memory (2) → PDF ingestion (2b) → Tauri desktop app (3) → inbound sync framework + GitHub connector (4).

## Components

| Component | Path | Run with | Purpose |
|---|---|---|---|
| Postgres 16 + pgvector | `docker-compose.yml` | `npm run db:up` | All ticket state, audit trail, and the pgvector knowledge index. Host port **5433**. |
| REST API | `src/api/` | `npm run dev` | Hono server on **:8787**. Bearer-auth. The service layer all writes route through. |
| MCP server | `src/mcp/` | `npm run mcp` | Same service layer as tools for AI agents (Claude Code/Cowork, Gemini, Codex, Cursor). stdio. |
| Ingest watcher | `src/ingest/` | `npm run ingest:watch` | chokidar watcher: indexes vault `.md` + `.pdf` into pgvector. |
| Sync CLI | `src/sync/` | `npm run sync:github` | Poll-based inbound sync: GitHub Issues → audited tickets. |
| Desktop app | `app/` | `cd app && npm run tauri:dev` | Tauri 2 + React pure client over the REST API. |

Every mutation — REST, MCP, ingest, or sync — goes through one service layer (`src/services/*`) inside a transaction and writes an append-only `events` audit row. Optimistic concurrency via a `version` column (stale write → HTTP 409).

## System requirements

| Requirement | Version | Needed for | Notes |
|---|---|---|---|
| **Node.js** | 20+ (tested on 24) | everything | ESM project |
| **npm** | 10+ | deps | |
| **Docker** + Docker Compose | any recent | Postgres+pgvector | image `pgvector/pgvector:pg16` (pgvector must be baked in — the plain `postgres` image will NOT work) |
| **Java (JDK)** | 11+ (Java 21 present) | PDF ingestion only | `@opendataloader/pdf` runs on the JVM; without it PDFs are skipped, markdown still ingests |
| **Rust / cargo** | stable (1.96 present) | building the desktop app only | installed at `~/.cargo/bin`; add to PATH before `tauri:dev`/`tauri:build`. Not needed for the server. |
| **Embedding API key** | — | real semantic search only | `EMBED_PROVIDER=fake` needs no key (deterministic, for dev/test) |
| **GitHub token** | — | GitHub sync only | classic/fine-grained PAT with repo read |

## External services, apps & repos

| Dependency | Type | Used by | Link |
|---|---|---|---|
| pgvector/pgvector:pg16 | Docker image | DB | https://hub.docker.com/r/pgvector/pgvector |
| Voyage / OpenAI / Gemini embeddings | HTTP API | knowledge embedding | Voyage default (`voyage-3`, 1024-dim). Only Voyage is wired in code today. |
| GitHub REST API (`@octokit/rest`) | HTTP API | sync connector | https://github.com/octokit/rest.js |
| `@opendataloader/pdf` | npm pkg (JVM) | PDF ingestion | https://github.com/opendataloader-project/opendataloader-pdf |
| Graphify | agent-side skill | optional knowledge graph, complements `search_knowledge` | https://github.com/Graphify-Labs/graphify — runs on the agent machine, NOT the server |
| Model Context Protocol SDK | npm pkg | MCP server | https://github.com/modelcontextprotocol |

Graphify is not a server dependency — install it in your AI assistant (Claude Code/Codex/Gemini/Cursor) and point it at the vault + repo for entity/relationship graph queries alongside the server's semantic search.

## Dependencies

**Server (`package.json`)** — runtime: `@modelcontextprotocol/sdk`, `@octokit/rest`, `@opendataloader/pdf`, `chokidar`, `drizzle-orm`, `hono`, `@hono/node-server`, `postgres`, `zod`. Dev: `drizzle-kit`, `tsx`, `typescript`, `vitest`, `@types/node`.

**Desktop app (`app/package.json`)** — runtime: `react` 19, `react-dom`, `@tanstack/react-query`, `@tanstack/react-router`, `@tauri-apps/api`, `@tauri-apps/plugin-http`, `@tauri-apps/plugin-store`, `@tauri-apps/plugin-opener`, `lucide-react`. Dev: `@tauri-apps/cli`, `vite`, `vitest`, `jsdom`, `@testing-library/*`, `@vitejs/plugin-react`, `typescript`.

**Rust (`app/src-tauri/Cargo.toml`)** — `tauri` 2, `tauri-plugin-http` 2, `tauri-plugin-store` 2, `tauri-plugin-opener` 2, `serde`, `serde_json`.

## Environment variables

| Var | Component | Required | Default / example |
|---|---|---|---|
| `DATABASE_URL` | all server | no (fallback) | `postgres://tickets:tickets@localhost:5433/tickets` |
| `PORT` | API server | no | `8787` |
| `EMBED_PROVIDER` | knowledge/ingest | for real embeddings | `voyage` \| `fake`. `fake` = no key, deterministic |
| `EMBED_MODEL` | knowledge/ingest | no | `voyage-3` (1024-dim) |
| `VOYAGE_API_KEY` | knowledge/ingest | if `EMBED_PROVIDER=voyage` | — |
| `VAULT_PATH` | ingest watcher | yes (for watcher) | path to the Obsidian vault |
| `TICKETS_API_KEY` | MCP server | yes (for MCP) | an actor's API key |
| `GITHUB_TOKEN` | sync | yes (for sync) | GitHub PAT |
| `SYNC_GITHUB_REPO` | sync | yes (for sync) | `owner/name` |
| `SYNC_GITHUB_PROJECT` | sync | yes (for sync) | internal project UUID to import into |

Note: the dev scripts do NOT auto-load `.env` — export vars in the shell, or run via `node --env-file=.env`. `DATABASE_URL` has a code fallback, so the DB works without it set.

## npm scripts

Server: `db:up`, `db:push`, `db:vector` (create pgvector extension), `db:vector:index` (hnsw index), `dev` (API), `mcp`, `ingest:watch`, `sync:github`, `test`, `typecheck`.
App (`app/`): `dev` (Vite), `build` (tsc+Vite), `tauri:dev`, `tauri:build`, `test`.

## Setup from scratch

```bash
# 1. server deps + database
npm install
npm run db:vector        # create pgvector extension (MUST run before db:push)
npm run db:up            # start Postgres on :5433
npm run db:push          # create schema
npm run db:vector:index  # create the hnsw vector index

# 2. run the API (fake embedder = no key needed)
EMBED_PROVIDER=fake npm run dev      # :8787

# 3. bootstrap an actor + project (one-off) to get an API key
#    (create via the actors/projects services, e.g. a tsx script calling createActor + createProject)

# 4. desktop app
cd app && npm install
export PATH="$HOME/.cargo/bin:$PATH"   # cargo must be on PATH
npm run tauri:dev                       # compiles Rust (~2 min first time), opens the window
#    In the app's Settings: server URL http://localhost:8787 + the API key

# 5. optional: vault ingestion (needs Java for PDFs)
VAULT_PATH=/path/to/vault EMBED_PROVIDER=fake npm run ingest:watch

# 6. optional: GitHub sync
GITHUB_TOKEN=... SYNC_GITHUB_REPO=owner/repo SYNC_GITHUB_PROJECT=<uuid> npm run sync:github
```

## Ports

- **5433** — Postgres (host; container maps to 5432, remapped because 5432 is often taken)
- **8787** — REST API

## Data model (tables)

`projects`, `actors` (hashed API keys), `tickets` (version-locked), `comments`, `events` (append-only audit, references ticket OR note), `notes` (writeable memory), `embeddings` (pgvector, vault+note projection), `sync_links` + `sync_comment_links` (external↔internal dedup).

## Deployment note

The API server, MCP server, ingest watcher, and sync CLI are all just DB clients — they need `DATABASE_URL` + their own env, and do not have to be co-located. The desktop app is a pure REST client and can point at any reachable server URL. The ingest watcher must run where the vault filesystem lives.
