# Typed memory and speak-first recall

Date: 2026-08-22. Status: approved design (approach A), pending implementation.

## Problem

VibeOps already indexes knowledge (notes, vault, sessions, repo, chat) and
injects search hits into forge plan/work prompts, but everything else is
pull-only: chat must remember to call `knowledge_search`, nothing fires by
itself, and there is no typed memory. A decision made on Tuesday is a chat
transcript chunk by Thursday, indistinguishable from a question. Rules
("migrations always go through the CLI") have no home and never fire.

basemode (github.com/ChristopherKahler/base) solves this for Claude Code with
a graph that "speaks first": it injects matching facts at session start, at
the prompt, and around tool calls, and it types memory as decisions with
rationale, domain-scoped rules, and handoffs. We adopt the ideas, not the
binary (PolyForm Noncommercial license). The code graph half of basemode is
deferred; this spec is memory and injection only.

## Decisions already made

- Surfaces that speak first: VibeOps chat turns (every lane), forge pipeline
  stages, and the user's Claude Code sessions via hooks.
- Capture: both automatic extraction after turns/stages and explicit tools.
- Code graph: deferred. Nothing in this spec touches AST or call graphs.
- Storage: typed memory lives on the existing `notes` table, not new tables.
  Recall reuses the existing embedding index. No graph store.

## Data model

Three nullable/defaulted columns on `notes`, one drizzle migration:

| column | type | values | default |
|---|---|---|---|
| `kind` | text | `note`, `decision`, `rule`, `handoff` | `note` |
| `domain` | text | free text, lowercased on write, e.g. `payments`, `extension` | null |
| `rationale` | text | why, for decisions | null |
| `source` | text | `manual`, `auto` | `manual` |

`kind` is text, not a pgEnum, so adding a kind later is a default-only
migration. `saveNote` accepts the new fields; every existing caller is
unchanged because all four have defaults. Indexing is unchanged: the
embedding content for a decision is `"<text>\nRationale: <rationale>"` so the
rationale is searchable; for a rule it is the rule text.

Scope rules are the existing ones: `global`, `project` (refId = project),
`ticket` (refId = ticket). Rules and decisions are normally `project` or
`global`. Handoffs are `project`.

## Recall

`src/services/recall.ts` exports:

```ts
type Recall = { rules: Note[]; decisions: Note[]; knowledge: KnowledgeHit[] };
recall(query: string, opts: { projectId?: string; domains?: string[]; limit?: number }): Promise<Recall>
formatRecall(r: Recall, maxChars = 2400): string
recallBlock(query, opts): Promise<string>   // recall + formatRecall, "" when empty
```

Ranking, in the order the block presents them:

1. **Rules fire by domain, not by similarity.** Every non-deleted `rule` whose
   `domain` is null (global) or is in `opts.domains` fires, scoped to the
   project or global. `opts.domains` defaults to the lowercased project name
   plus any `#domain` tokens in the query. Capped at 10, newest first.
2. **Decisions by similarity.** `searchKnowledge(query, { limit: 10, projectId })`
   hits whose `sourceKind` is `note` are joined back to `notes`; those with
   `kind = decision` are listed with their rationale. Capped at 5.
3. **Knowledge** is whatever remains of those hits, capped at 5, same
   formatting the `/prime` route already uses.

`formatRecall` emits a plain-text block:

```
Memory (rules fire for: <domains>):
Rules:
- [payments] Migrations always run through the CLI, never raw SQL.
Decisions:
- [extension] Heartbeat via chrome.alarms at 30s. Rationale: MV3 kills idle workers at ~30s; alarms are the only wakeup that survives.
Knowledge:
- [chat 0.81 2026-08-20] ...
```

Sections with nothing are omitted. An empty recall returns `""` so callers
inject nothing rather than a header over nothing. The block is wrapped with
`fenceUntrusted("memory", ...)` wherever it enters a prompt, same as
knowledge today: memory is data the model reads, never instructions it obeys.

## Injection points

**Chat (`src/chat/turns.ts`).** Before dispatch, `recallBlock(userBody,
{ projectId: session.projectId })` is computed once per turn and prepended to
the system text every lane already receives: SDK lane `systemPrompt`, CLI lane
`sys`, HTTP lane `system`. A recall failure logs a warning and injects
nothing; it never fails the turn.

**Forge (`src/relay/prompts.ts`).** `composePlanPrompt` and `composeWorkPrompt`
take an optional `memory: string` and, when non-empty, add
`\nMemory:\n<fenced block>` directly above `Relevant knowledge`. The caller
that already fetches knowledge for a stage fetches the memory block with the
ticket title as the query and the ticket's project.

**Claude Code hooks.** Two scripts, both fail-open (print nothing, exit 0 on
any error), mirroring the existing `scripts/prime.mjs`:

- `SessionStart` → existing `scripts/prime.mjs`. `/prime` gains a first line
  with the newest `handoff` for the project when one exists.
- `UserPromptSubmit` → new `scripts/recall-hook.mjs`: reads the hook JSON from
  stdin, takes its `prompt` field as the query, calls new `GET /recall?q=`,
  prints the block.

`GET /recall` is member-level auth like `/prime`, returns `recallBlock` as
text, 4000 char cap. `npm run hooks:install` runs `scripts/install-hooks.mjs`,
which merges both hooks into `~/.claude/settings.json` idempotently (a second
run changes nothing), writes a `settings.json.bak-vibeops` first, and prints
what it added. It never removes hooks it did not add.

## Capture

**Explicit.** Tools on both the chat SDK lane and the MCP server:

- `save_decision { text, rationale, domain?, scope?, refId? }`
- `save_rule { text, domain, scope?, refId? }`

Both call `saveNote` with the kind. Scope defaults to `project` when the chat
session has a project, else `global`. Domain is lowercased.

**Automatic.** After a chat turn's assistant message is stored, and after a
forge work stage reports, `captureMemory({ text, projectId, source: "auto" })`
runs in the background (not awaited by the turn):

- Extractor: the cheapest available lane. v1 uses the SDK lane with model
  `haiku`, no tools, a fixed extraction prompt, and requires a JSON-only reply
  `{ "decisions": [{ "text", "rationale", "domain" }], "rules": [{ "text", "domain" }] }`.
  No credentials, a non-JSON reply, or any error: skip silently (warn log).
- Input: the last user+assistant pair for chat; the REPORT section for a work
  stage. Never the whole transcript.
- Dedupe: an item whose lowercased text already exists as a non-deleted note
  of the same kind in the same scope is not saved again.
- Setting `memory.autoCapture` (`on`/`off`, default `on`) disables it.
- Hard cap: at most 5 items per capture call. Extraction that returns more is
  truncated, not rejected.

**Handoff.** A chat message that is exactly `*handoff` (optionally followed
by free text) does not go to the model. It saves a `handoff` note for the
session's project: the free text if given, else the last assistant message,
prefixed with the session title. The reply is the saved note. `/prime` shows
the newest handoff first. `*handoff` with no project in the session is
refused with a one-line reason.

## Out of scope

Code graph, before-tool and after-tool hooks (they are the code-graph
surface), a memory UI, supersedes chains, multi-agent relay, importing
basemode data.

## Testing

- Migration applies on the embedded lane; `saveNote` round-trips kind,
  domain, rationale, source; defaults keep every existing `saveNote` caller
  passing unchanged.
- `recall`: a rule with domain `payments` fires for domains `["payments"]`
  and not for `["billing"]`; a global rule (null domain) always fires;
  decisions come back from similarity with rationale attached; knowledge is
  what remains; `formatRecall` omits empty sections and returns `""` for an
  empty recall; the char cap truncates knowledge before rules.
- Chat injection: with a fake agent, the system prompt the agent receives
  contains a saved rule's text; a recall failure (stubbed throw) still
  completes the turn.
- Forge: `composeWorkPrompt` with memory places the fenced block above
  knowledge; without memory the output is byte-identical to today.
- `/recall` route returns the block; `recall-hook.mjs` prints the block for
  a stdin JSON `{ "prompt": "..." }` and prints nothing on a dead server.
- `install-hooks.mjs` on a temp HOME: first run adds both hooks and writes
  the backup; second run is a no-op; pre-existing unrelated hooks survive.
- Tools: `save_decision` and `save_rule` create notes with the right kind
  and lowercased domain; scope defaults follow the session's project.
- Auto-capture: with a fake extractor, a turn produces the extracted notes
  with `source = auto`; duplicates are not re-saved; the 5-item cap holds;
  the setting `off` produces nothing; an extractor throw leaves the turn's
  result untouched.
- `*handoff` saves the note and does not invoke the agent; `/prime` leads
  with it; no-project sessions are refused.
