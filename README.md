# VibeOps

**One audited brain for you and your AI agents.**

VibeOps is a self-hosted ticketing engine with a built-in knowledge/RAG layer, reachable over REST and MCP — so a human in the desktop app and every AI coding agent you run (Claude Code, Codex, Gemini, Antigravity, Cursor) share the same tickets, the same searchable memory, and the same append-only audit trail.

Vibecoding with multiple agents has a coordination problem: each agent starts cold, re-derives decisions the last one already made, and nothing records who did what. VibeOps fixes the substrate — shared state, shared memory, per-agent identity — and installs as a single file with zero configuration.

## What it does

**Tickets with integrity.** Real transactions, optimistic concurrency (version-locked updates return 409 instead of silently clobbering), and an append-only event log where every mutation is attributed to the actor that made it. Agents track multi-step work as tickets other agents can see, instead of private todo lists.

**Knowledge that survives sessions.** A pgvector index over three layers, searchable through one `search_knowledge` tool from any connected agent:

- **Your vault** — `~/.vibeops/vault` is created on first run and indexed automatically. Drop markdown or PDF files in, or open it as an Obsidian vault (Obsidian is optional; any editor works). Point one setting at an external vault instead if you have one.
- **Notes** — a writeable document workspace (titled, versioned, audited, soft-deleted) agents use to persist decisions and gotchas.
- **Session memory** — transcripts from Claude Code, claude-mem, Codex, and Antigravity are ingested so what one agent did is retrievable by every other agent.

**Zero-key by default.** Embeddings run on a local ONNX model (all-MiniLM, ~23MB one-time download) — knowledge search works out of the box with no API key. Bring a Voyage key later if you want API-grade embeddings.

**One-click agent connection.** VibeOps serves MCP over streamable HTTP from the same process. The MCP settings card writes Cursor and Gemini configs for you (with a backup of anything it touches) and hands you a ready `claude mcp add` command for Claude Code.

**Per-agent identity and roles.** The bootstrap owner key is admin; mint a member key per agent from the Actors card. Members get the full collaborative work surface; only admins touch settings, provider keys, filesystem indexing, config writes, or key minting. The audit trail answers "which agent did this."

**Honest observability.** The Token Usage tab shows each coding agent's signed-in account and its real token usage read from local session logs — and explicitly tells you what VibeOps cannot see (provider-side quotas and reset limits). No fabricated dashboards.

## Install (one file)

Grab or build the installer — a single artifact per platform (NSIS `.exe` on Windows; `deb`/`AppImage` configs for Linux):

```bash
npm run build:sidecar          # bundles the server + portable Node (sha256-verified)
cd app && npm run tauri:build  # requires Rust
```

First launch self-creates everything: an embedded Postgres-compatible database (PGlite with pgvector), the Inbox project, an owner API key at `~/.vibeops/credentials.json`, and your vault. The app spawns its own bundled server on `127.0.0.1:8787` — or attaches if one is already running. Quitting the app stops it. `~/.vibeops` is never touched by install or uninstall.

## Quick start (from source)

Node 20+ is the only prerequisite for standalone mode:

```bash
npm install
npm run dev    # REST API on :8787 — embedded DB, migrations, bootstrap, vault, all automatic
```

The desktop app auto-detects credentials. `~/.vibeops` is the single backup unit: copy the folder to back up; restore it before first run on a new machine. Treat `credentials.json` like `~/.ssh`.

Useful scripts: `npm run ingest:sessions` (index recent agent sessions), `npm run ingest:watch` (standalone vault watcher), `npm run mcp` (stdio MCP server for external-Postgres setups), `npm test`.

## Connect an agent

VibeOps serves MCP at `http://127.0.0.1:8787/mcp` (streamable HTTP, bearer-key auth — same key as REST). From the app: Settings → MCP Servers → the connect card writes Cursor/Gemini configs one-click and gives Claude Code users a copy-paste command. For scripting: `GET /mcp/config` returns per-client snippets; `POST /mcp/install` performs the write.

Give each agent its own key (Settings → Local Node → Actors) so the audit trail can tell them apart, then generate that agent's MCP config by calling `GET /mcp/config` with the agent's key.

Make agents actually use the shared brain: add a few lines to your agent instructions (CLAUDE.md / AGENTS.md / GEMINI.md) — search knowledge before starting, save decisions after finishing, track multi-step work as tickets. This repo's `AGENTS.md` has the canonical block.

## Auto-priming

Give a fresh agent session a head start instead of starting cold: `scripts/prime.mjs` calls `GET /prime?q=<query>` and prints a compact plain-text digest of the most relevant knowledge (vault, notes, sessions) for that query. It reads `~/.vibeops/credentials.json` itself — no config needed — and defaults the query to the current directory name if you don't pass one.

Wire it into Claude Code as a `SessionStart` hook so every new session opens with relevant context already injected:

```json
{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "node D:/Github/tickets/scripts/prime.mjs" } ] } ] } }
```

Any agent with its own hook system (or a shell alias run before starting a session) can call the same script — `/prime` is member-level and read-only, so no admin key is required.

## Cross-model pipeline (relay)

Ticket work has three roles — plan, work, review — and each can run against a different agent or model, so the expensive reasoning model touches a ticket only twice (writing the plan, then reviewing the diff) while a cheap or local model grinds through the actual implementation loop in between.

- **plan**: reads the ticket and relevant knowledge, posts a `plan` comment, moves the ticket to `planned`.
- **work**: claims a `planned` ticket (optimistic-locked — two workers racing for the same ticket never both claim it), implements the plan, posts a `report` comment, moves the ticket to `review`.
- **review**: reads the plan, the report, and the real `git diff`, then closes the ticket on `VERDICT: PASS` or bounces it back to `planned` with findings on `VERDICT: FAIL`.

### Quickstart

Create `~/.vibeops/relay.json`:

```json
{
  "workdir": "D:/Github/myproject",
  "agents": {
    "fable": { "cmd": ["claude", "-p", "{promptFile}"], "roles": ["plan", "review"] },
    "codex": { "cmd": ["codex", "exec", "--oss", "--sandbox", "workspace-write", "-C", "{workdir}", "{prompt}"], "roles": ["work"] }
  }
}
```

`codex exec --oss` runs the work loop against a local open-weights model through Codex's own runtime — you don't need Ollama installed until you want `work` on a model Codex doesn't bundle.

Run one pass per role:

```bash
npm run relay -- --role plan --agent fable
npm run relay -- --role work --agent codex
npm run relay -- --role review --agent fable
```

Add `--watch` to poll continuously instead of running once, and `--ticket <id>` to target a specific ticket instead of the oldest one in that role's queue.

### Security note

`relay.json` — including the exact command each agent runs — lives in a local file, never the settings table. An admin API key can already read and write ticket data; if command templates lived in the DB too, that same key would amount to arbitrary command execution on whatever machine runs the relay. Keeping it filesystem-only means compromising the API can't compromise the shell.

## Architecture

```text
Desktop app (Tauri)  ──┐
Claude Code / Cursor ──┤── REST + MCP ──► one service layer ──► Postgres (truth: tickets, notes,
Codex / Gemini ────────┘    (bearer keys,      (transactions,       events, settings, actors)
                             admin/member       audit, 409s)          │
                             roles)                                   └─► pgvector (rebuildable
                                                                           projection: vault, notes,
Vault watcher ──────────── markdown / PDF ────────────────────────────────  session transcripts)
Session ingestion ──────── Claude Code / claude-mem / Codex / Antigravity ┘
```

- **Truth vs. retrieval:** authoritative records live in Postgres tables; pgvector holds embeddings — a projection you can always rebuild, never the sole record.
- **Database seam:** `DATABASE_URL` set → external Postgres; otherwise an embedded PGlite database in `~/.vibeops/data`. Same code, same migrations (additive-only, run at boot).
- **One code path:** REST and MCP both route through the same service layer, so every mutation lands in the same audit trail no matter who made it.

## Security model

Local-first, single trust boundary: the embedded server binds loopback only; every request needs a bearer key; keys are stored as sha256 hashes; admin/member roles gate host-touching operations (settings, provider keys, filesystem indexing, MCP config writes, key minting, session ingestion). Written client configs and `credentials.json` hold plaintext keys with owner-only file permissions — same trust level as `~/.ssh`. Portable Node downloads are verified against the published sha256 manifest; the local embedding model is pinned to a specific revision.

Session ingestion indexes conversation text from your own machine; tool output is stripped, but secrets pasted directly into chats can be indexed — treat the knowledge base accordingly.

## Advanced: external Postgres

```bash
export DATABASE_URL="postgresql://user:password@localhost:5433/vibeops"
npm run db:vector && npm run db:push && npm run db:vector:index
npm run dev
```

External mode serves all interfaces (for LAN/VPS use) and does not auto-bootstrap. The stdio MCP server (`npm run mcp`) is the right transport when agents run on a different machine than the server.

## Knowledge ingestion details

The vault watcher indexes `.md` and `.pdf` (PDF via a JVM-backed converter — needs Java 11+; without it PDFs are skipped with a warning). Files are hash-gated (unchanged files cost nothing on re-index) and deletions leave the index. Session ingestion (`npm run ingest:sessions` or the Sync button in the app) covers the last 30 days by default (`SESSIONS_SINCE_DAYS`), is hash-gated, and is safe to re-run. Run anything with `EMBED_PROVIDER=fake` for a no-network dry run.

## License

[MIT](LICENSE)
