## Trust model
The design is strictly single-owner-plus-their-agents. It is explicitly NOT multi-tenant.
- **One human owner**: The system is designed for a single human operator.
- **Agents as members**: Agents act as semi-trusted `member` actors.
- **Blast radius**: A leaked `member` key can read workspace-wide tickets and notes (by design), but it cannot mutate settings, actors, budgets, forge gates, or access admin-only or council surfaces.
- **Rotation**: Key rotation is done by revoking the actor and re-minting a new one.
- **Secrets**: `relay.json` contains sensitive command templates and is never served by the API.

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
- Operator notes travel via `operatorNotes` API field only, rendered trusted/unfenced in the review prompt; nothing derived from ticket body, comments, or worker output ever populates it. Workers no longer need to relay supervisor context through REPORT — operator sets it once via the pipeline start call.

## Best-effort, not guaranteed
Fencing and reviewer instructions raise the bar but a sufficiently crafted injection can still degrade WORK quality or bias a model's narrative — this is a property of LLMs reading text, not something a string wrapper can fully close. The backstop is structural, not persuasive: PASS never auto-closes a ticket; a human must call `/forge/tickets/:id/promote`, which mechanically requires an admin-authored comment (verified by `actors.role`, not by prompt content) and a non-empty sandbox diff. No amount of prompt injection can forge that row.

## Cross-reference
Coordinate with ticket 1e77343f's trust-model doc rather than duplicating actor/role model description here.
