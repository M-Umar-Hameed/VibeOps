# Session Record Design — Browser Epic A

Decision and session record for reverse-engineerable agent work.

## Context

Agents complete work; humans cannot reverse-engineer it afterward. Missing: what was decided, why, what steps were taken, outcome, whether it was worth it.

Three requirements:
1. **Evidence-then-consent** — before mutating anything, search existing state for overlap, show the human, record their choice.
2. **Session record** — ordered steps with reasoning, outcome, cost. Reconstructable six months later without re-running.
3. **Reuse** — next person asking the same question gets the prior finding, not fresh investigation.

Design principle: informed-consent record, not blame shield. Build for decision revisitation (short record, evidence that mattered) — this is also the only version reusable later.

## What a Session Record Contains

| Component | Purpose | Source |
|-----------|---------|--------|
| Ticket | Shell: what was asked, why | `tickets` table (title, body) |
| Comments | Ordered steps, reasoning, outcome | `comments` table |
| Events | Append-only audit trail | `events` table (`comment.added` etc.) |
| Decision note | Indexed for reuse/search | `notes` with `scope:"ticket"` |
| Cost | Tokens, cost, duration | `forgeRuns` + `aiUsageLogs.ticketId` |

## Where It Is Stored — Reused vs New

### Reused (unchanged)

| Table/Column | Role | Citation |
|--------------|------|----------|
| `tickets` | Record shell | `src/db/schema.ts:20-32` |
| `comments` + `events` | Steps, reasoning, audit | `src/db/schema.ts:44-60` |
| `comments.kind` | Distinguish comment types | `src/db/schema.ts:47` — **free text**, not enum |
| Existing comment kinds | `plan`, `report`, `review`, `verification`, `diff-summary` | `src/services/comments.ts:12` |
| `notes` + `embeddings` | Indexed decision storage | `src/db/schema.ts:78-90` |
| `saveNote` → `insertNoteEmbedding` | Auto-indexing | `src/services/notes.ts:29` |
| `searchKnowledge` | Reuse lookup | `src/services/knowledge.ts:193` |
| `forgeRuns` + `aiUsageLogs` | Cost per ticket | `src/db/schema.ts:142,167` |

### New (two comment-kind literals)

| Item | Purpose | Migration required |
|------|---------|-------------------|
| `"evidence"` comment kind | Overlap shown before mutation | **No** — `kind` is `text("kind")` at `src/db/schema.ts:47`, not a pgEnum. Widen TS union at `src/services/comments.ts:12`. |
| `"decision"` comment kind | Recorded choice with cited artifact | **No** — same reason. |

**Case for new items:** Existing kinds (`plan`, `report`, etc.) describe agent work outputs. `evidence` and `decision` describe human-facing consent flow — distinct semantic role, worth explicit kind for filtering and display. Zero schema change: just two string literals added to the TypeScript union.

**Convention (not schema):** After writing a `decision` comment, mirror its content to a `scope:"ticket"` note via `saveNote`. This enters `embeddings` automatically (`insertNoteEmbedding`) and becomes searchable via `searchKnowledge`.

## How It Is Searched

```
Request arrives
    ↓
searchKnowledge(query, { scope: "ticket" })  ← src/services/knowledge.ts:193
    ↓
pgvector cosine search over embeddings of prior decision notes
    ↓
Candidates returned with refId (ticket id) + body (contains artifact block)
    ↓
Confidence gate (below) determines whether to raise objection
```

Reuse path is existing: `saveNote(scope:"ticket")` → `insertNoteEmbedding` → `embeddings` table → `searchKnowledge` returns matches.

## Confidence Rule — The Hard Part

**Mechanical threshold, not runtime judgement.**

### Two-Stage Gate

1. **Nomination (cosine)** — `searchKnowledge` returns candidates ranked by vector similarity. This stage **only shortlists**; it never raises an objection on its own.

2. **Confirmation (exact-match)** — A candidate is raised as "you already have this" **only when**:
   - A concrete artifact block is present in the candidate
   - Artifact ID is present AND
   - Trigger field exact-matches AND
   - At least one resource field exact-matches (table, target, mapping, etc.)

### Artifact Block Schema

Every `decision`/`evidence` comment carries a machine-parsable artifact block (fenced JSON):

```json
{
  "artifact": "zap",
  "id": "12345",
  "trigger": "airtable.record_created",
  "table": "Leads",
  "target": "slack.post_message",
  "channel": "#sales"
}
```

Fields:
- `artifact` — type (zap, workflow, integration, etc.)
- `id` — external system identifier (required for objection)
- `trigger` — event that fires the artifact
- Resource fields — `table`, `target`, `channel`, `mapping`, etc. (domain-specific)

### Objection Logic

```
IF candidate.artifact.id IS NOT NULL
   AND candidate.artifact.trigger == request.trigger
   AND (candidate.artifact.table == request.table
        OR candidate.artifact.target == request.target
        OR candidate.artifact.mapping == request.mapping)
THEN raise objection with cited id and matched fields
ELSE stay silent
```

Objection message **must** quote: the matched artifact ID, the trigger, and the matched resource field(s). If any is missing, objection is not emitted.

### Rationale

Two false positives and users click through every warning forever. Silence is cheaper than a wrong alarm. Semantic similarity (cosine only) is never sufficient — it nominates, it does not confirm.

## Worked Example — Duplicate Zap

### Scenario

User opens ticket: "New Zap — read Airtable `Leads`, post to Slack `#sales`."

### Flow (objection fires)

1. **Search** — Before any mutation, system calls `searchKnowledge("airtable leads slack post")` over prior `decision` notes.

2. **Nomination** — Returns candidate with artifact block:
   ```json
   {
     "artifact": "zap",
     "id": "12345",
     "trigger": "airtable.record_created",
     "table": "Leads",
     "target": "slack.post_message",
     "channel": "#sales"
   }
   ```

3. **Confirmation gate**:
   - Request: `trigger=airtable.record_created`, `table=Leads`
   - Candidate: `id=12345` present, `trigger=airtable.record_created` exact match, `table=Leads` exact match
   - **Gate passes → objection fires**

4. **Evidence comment written**:
   ```
   kind: evidence
   body: "This exists — Zap 12345, same trigger `airtable.record_created`,
         same table `Leads`. Add an email step to 12345 instead of a
         second Zap that double-fires."
   ```

5. **Human decides** — With evidence on screen, chooses to extend existing Zap.

6. **Decision comment written**:
   ```
   kind: decision
   body: "Chose: extend Zap 12345, add email step instead of new Zap."
   artifact: { ... existing block with action: "extend" ... }
   ```

7. **Index for reuse** — `saveNote(scope:"ticket", refId: ticketId, body: decision.body)` → enters `embeddings` → next person asking gets this finding.

### Counter-case (objection suppressed)

Request: "Airtable `Contacts` → Slack `#sales`"

1. **Search** — `searchKnowledge("airtable contacts slack post")` returns Zap 12345 as candidate (cosine similarity).

2. **Confirmation gate**:
   - Request: `trigger=airtable.record_created`, `table=Contacts`
   - Candidate: `id=12345` present, `trigger=airtable.record_created` match, but `table=Leads` ≠ `Contacts`
   - **Gate fails → no objection**

3. **Result** — System proceeds silently. The semantic near-match is not surfaced as a warning.

## Summary

### New vs Reused

| Category | Items |
|----------|-------|
| **Reused** | `tickets`, `comments`, `events`, `notes`, `embeddings`, `forgeRuns`, `aiUsageLogs`, `saveNote`, `insertNoteEmbedding`, `searchKnowledge`, existing comment kinds |
| **New** | Two comment-kind string literals: `"evidence"`, `"decision"` (no DB migration — `kind` is free text) |
| **Convention** | Mirror `decision` comments to ticket-scoped notes for searchability |

### Deferred to Epic B/C/D

- Live connector to external systems (Zapier, Airtable, etc.)
- Actual artifact discovery and field extraction from external APIs
- UI for evidence/decision display and consent flow
- Automated cost aggregation display

This doc defines the record structure and confidence gate only. Implementation of browser-control features writes into this foundation.
