## Threat model
Prompt injection via untrusted text (ticket bodies, synced comments, RAG knowledge chunks, session transcripts) concatenated into plan/work/review/council prompts is the primary injection surface here, not SQLi (parameterized queries throughout via drizzle).

## Defenses in place
- Arg-vector `spawn` only, no shell interpolation (`src/relay/invoke.ts`, `src/forge/sandbox.ts`, `src/services/projects.ts`);
- Fail-closed, line-anchored, last-match `VERDICT`/`VERIFICATION` parsing (`src/relay/prompts.ts`);
- Admin-authored-only gate on both the promote path (`src/api/forge-routes.ts` `lastVerdict()`) and the close-with-verification path (`src/services/tickets.ts`);
- Untrusted-content fencing with a standing data-not-instructions clause on every composed prompt (`src/relay/prompts.ts`, `src/council/personas.ts`);
- Reviewer-specific injection-detection instruction;
- Marketplace path containment (resolve+prefix check);
- Secret redaction on ingest and before any durable comment write (`src/forge/redact.ts`);
- `relay.json` (0600, command templates) never enters the settings DB or any API response;
- repoPath/workdir validated absolute with no `..` segments before any git operation;
- Export filenames stripped of CR/LF/quotes/non-ASCII;
- No `dangerouslySetInnerHTML` anywhere in `app/src`.

## Best-effort, not guaranteed
Fencing and reviewer instructions raise the bar but a sufficiently crafted injection can still degrade WORK quality or bias a model's narrative — this is a property of LLMs reading text, not something a string wrapper can fully close. The backstop is structural, not persuasive: PASS never auto-closes a ticket; a human must call `/forge/tickets/:id/promote`, which mechanically requires an admin-authored comment (verified by `actors.role`, not by prompt content) and a non-empty sandbox diff. No amount of prompt injection can forge that row.

## Cross-reference
Coordinate with ticket 1e77343f's trust-model doc rather than duplicating actor/role model description here.
