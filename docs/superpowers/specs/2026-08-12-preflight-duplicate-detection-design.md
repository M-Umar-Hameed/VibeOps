# Implementation Plan — Browser Epic D: preflight duplicate detection

## The Pre-Flight Flow
The duplicate detection flow executes in the following sequence:
1. **Two-pass retrieval**: `preflightDuplicateCheck` runs retrieval in two passes:
   - **Pass 1 (exact-match)**: `findByTrigger` queries embeddings for notes containing the literal trigger string (e.g. `%"trigger": "airtable.record_created"%`). This guarantees retrieval when present — semantic ranking cannot push the duplicate out of top-k.
   - **Pass 2 (semantic fallback)**: `searchKnowledge` with cosine similarity surfaces candidates that may be indexed differently.
2. **Confirmation Gate**: The `confirmObjection` gate strictly filters out near-matches, verifying exact property intersections.
3. **Evidence Comment**: If a duplicate is confirmed, an `evidence` comment is written citing the artifact.
4. **Human Decides**: The user reviews the evidence and makes the final decision. Preflight never blocks.
5. **Decision Recorder**: A `decision` comment is written and concurrently mirrored to a ticket-scoped note (`recordDecision`), closing the reuse loop for future preflights.

## Reliable Retrieval (not hopeful retrieval)
The `confirmObjection` gate already requires an exact trigger match to fire at all. This observation led to Pass 1: if the gate will discard candidates whose trigger differs, we can use SQL LIKE on the JSON-encoded trigger to find candidates reliably. This avoids the fragility of relying on semantic ranking to surface the duplicate in top-k when thousands of indexed artifacts exist. The semantic pass remains as fallback for edge cases (e.g., trigger stored in a different JSON shape).

## Resolved Contradictions

1. **`searchKnowledge` signature.** Epic A originally cited `searchKnowledge(query, { scope: "ticket" })`. The real signature (`src/services/knowledge.ts:196`) has no `scope` param. Resolution: preflight passes `projectId`, and `projectScopeWhere` (`src/services/knowledge.ts:168-181`) handles surfacing ticket-scoped notes for the project (`n.scope='ticket' AND t.project_id = projectId`).
2. **Artifact block is not structured in retrieval.** `searchKnowledge` returns raw string `content`. Resolution: the decision note body embeds the fenced JSON block; preflight re-parses it via regex.
3. **`path`/`pathReason` are not gate inputs.** Epic B made them required, but they describe how a new automation runs, which is irrelevant for detection. Resolution: the objection gate keys only on `id` + `trigger` + resource field.

## Gate Rule Verbatim
Gate rule from `src/services/preflight.ts`:
```ts
// Mechanical objection gate — NOT a semantic judgement (ticket: never a hunch).
// Fires only when a concrete artifact can be cited:
//   candidate.id present, trigger exact-match, and >=1 resource field exact-match.
// Returns the matched field names (for the evidence message) or null (stay silent).
export function confirmObjection(request: ArtifactBlock, candidate: ArtifactBlock): string[] | null {
  if (!candidate.id) return null;
  if (!request.trigger || !candidate.trigger) return null;
  if (request.trigger !== candidate.trigger) return null;
  const matched = RESOURCE_FIELDS.filter((f) => request[f] != null && request[f] === candidate[f]);
  if (matched.length === 0) return null;
  return ["trigger", ...matched];
}
```

## Never Blocks
Preflight **never refuses/blocks**. It solely evaluates evidence and surfaces it. The human decides the outcome, and their choice is recorded along with the evidence they saw.

## Deferred
- No live connector / no automation discovery from external systems.
- No UI. Preflight returns evidence as data; caller renders it.

## Code Citations
- `src/services/preflight.ts` - core preflight definitions: `ArtifactBlock`, `parseArtifactBlock`, `confirmObjection`, `findByTrigger`, `preflightDuplicateCheck`, `recordDecision`.
- `src/services/preflight.ts:69-85` (`findByTrigger`) - exact-match SQL lookup for reliable retrieval.
- `src/services/knowledge.ts:194` (`searchKnowledge`) - semantic retrieval entry point.
- `src/services/knowledge.ts:168-181` (`projectScopeWhere`) - why ticket notes surface.
- `src/services/notes.ts:8` (`saveNote`) - saving decisions.
- `src/services/comments.ts:12` - widened comment kinds union with `evidence | decision`.
