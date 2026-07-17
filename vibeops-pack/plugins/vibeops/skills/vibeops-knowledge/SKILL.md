---
name: vibeops-knowledge
description: Search-first, save-after habits for the VibeOps shared knowledge base — search_knowledge, save_note, and session priming.
---

# VibeOps Knowledge

VibeOps indexes three layers — your vault, notes, and session transcripts — behind one `search_knowledge` tool, so decisions and gotchas from any agent's past sessions are retrievable by every other agent.

## Search first

Before starting a task, run one `search_knowledge` query on the task's topic. Prior decisions, specs, and traps already live there — use them instead of re-deriving from scratch.

## Save after

After completing meaningful work, `save_note`:

- scope `global` (unless the note is specific to one project or ticket, in which case use `project`/`ticket` scope with `refId`).
- give it a `title`.
- write the WHY in 3-6 sentences: what was decided, what broke, what to avoid next time — not what the code or git history already records.

Never save secrets, API keys, or credentials. Session ingestion indexes conversation text, and secrets pasted into chats can end up in the knowledge base — treat it accordingly.

## Managing notes

Notes are versioned like tickets: `update_note` and `delete_note` require `expectedVersion`. `list_notes` filters by `scope` and `refId`.

## /prime at session start

`scripts/prime.mjs` calls `GET /prime?q=<query>` and prints a compact digest of the most relevant knowledge for that query, using the credentials in `~/.vibeops/credentials.json` — no config needed. Wire it into a fresh agent session as a `SessionStart` hook so every new session opens with relevant context already injected, instead of starting cold.

`/prime` is member-level and read-only, so no admin key is required to run it.
