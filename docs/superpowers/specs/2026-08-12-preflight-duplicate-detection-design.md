# Implementation Plan — Browser Epic D: preflight duplicate detection

## The Pre-Flight Flow
The duplicate detection flow executes in the following sequence:
1. **Search**: `preflightDuplicateCheck` invokes retrieval against previous automated decisions.
2. **Nomination**: Cosine similarity surfaces previous `decision` notes.
3. **Confirmation Gate**: The `confirmObjection` gate strictly filters out near-matches, verifying exact property intersections.
4. **Evidence Comment**: If a duplicate is confirmed, an `evidence` comment is written citing the artifact.
5. **Human Decides**: The user reviews the evidence and makes the final decision. Preflight never blocks.
6. **Decision Recorder**: A `decision` comment is written and concurrently mirrored to a ticket-scoped note (`recordDecision`), closing the reuse loop for future preflights.

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
- `src/services/preflight.ts` - core preflight definitions.
- `src/services/knowledge.ts:196` (`searchKnowledge`) - entry point.
- `src/services/knowledge.ts:168-181` (`projectScopeWhere`) - why ticket notes surface.
- `src/services/notes.ts:8` (`saveNote`) - saving decisions.
- `src/services/comments.ts:12` - widened comment kinds union.
