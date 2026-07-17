---
name: vibeops-tickets
description: Ticket workflow for any agent — statuses, optimistic version locking, typed comments, claim etiquette, REST and MCP surfaces.
---

# VibeOps Tickets

Track multi-step work as tickets other agents can see, instead of a private todo list. Every mutation lands in one audit trail no matter whether it came in over REST or MCP.

## Statuses

A ticket's `status` is one of: `open`, `planned`, `in_progress`, `review`, `closed`.

Typical flow: `open` -> plan written -> `planned` -> worker claims -> `in_progress` -> work done, report posted -> `review` -> reviewer verdict -> `closed` (PASS) or back to `planned` (FAIL).

## Optimistic version locking

Every ticket (and note) carries a `version` field. Any update — `update_ticket`, `update_note`, `delete_note` — requires `expectedVersion`. If the ticket's current version doesn't match what you pass, the update is rejected as a conflict instead of silently clobbering a concurrent change.

Never blind-overwrite: refetch the ticket, read its current `version`, and retry with that value. When two workers race to claim the same `planned` ticket, exactly one succeeds; the loser sees a conflict and should move on to a different ticket rather than retrying the same claim.

## Typed comments

Comments carry a `kind`: `comment`, `plan`, `report`, or `review`. Use the typed kinds so other agents (and the relay/forge pipeline) can find the latest plan, report, or review without re-reading every comment:

- `plan` — the implementation plan for the ticket.
- `report` — what a worker did, ending with a `REPORT:` section.
- `review` — a reviewer's verdict and findings.
- `comment` — anything else (questions, status notes).

## Claim etiquette

Never leave a ticket stuck in `in_progress`. If your work fails or you have to stop, post a `report` comment explaining why and move the ticket back to `planned` so another pass can pick it up. Both the relay CLI and the forge pipeline enforce this invariant on every failure path.

## REST + MCP surfaces

Both surfaces route through the same service layer — one audit trail no matter which one an agent uses.

MCP tools: `create_ticket`, `update_ticket`, `comment`, `search_tickets`, `get_ticket_history`.

Example claim-and-report loop (MCP):

1. `search_tickets` for a ticket in `planned`.
2. `update_ticket({ id, expectedVersion, status: "in_progress" })` — if this conflicts, someone else claimed it; pick another ticket.
3. Do the work.
4. `comment({ ticketId, body: "...", kind: "report" })`.
5. `update_ticket({ id, expectedVersion, status: "review" })`.
