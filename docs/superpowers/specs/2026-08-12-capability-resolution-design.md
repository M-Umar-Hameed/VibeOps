# Browser Epic B: Capability Resolution

## Resolution order

The capability resolution follows a strict 4-step order to determine whether to use an API or a browser path:

1. Is there an API path for **this specific operation** — resolved from the per-connector capability manifest (hint) **plus** an MCP-connected check; never "does the vendor have an API." State that per-operation granularity is required because connectors like SugarCRM have partial API coverage.
2. Do we hold credentials for this tenant, authorised for it — a lookup in **global** settings (cite `docs/superpowers/specs/2026-07-18-project-integrations-design.md:9-18`), scoped to the operation.
3. If step 1 or 2 fails → use the browser path on the profile bound to that tenant.
4. Record which path ran AND why (see [Recording the path](#recording-the-path-reason-into-the-session-record)).

```
IF per_connector_manifest has apiOperation for this specific operation
   AND mcp_connection is active
   AND global_settings has credentials for this tenant scoped to the operation
THEN use API path
ELSE use browser path on the profile bound to that tenant
```

## Where capability data lives & who maintains it

The static capability data is a per-connector capability manifest, checked into the repo, code-reviewed, versioned — not a DB table. It is keyed by operation id, with each entry declaring `apiOperation` availability, required credential keys, and MCP tool binding if any. The maintainer is the connector owner via PR review (same discipline as `src/sync/connectors/github.ts`). The reason it is not a DB table is that a hand-edited row silently drifts; a manifest change goes through review and, more importantly, is only ever a *hint*.

## API path exists but fails at runtime

The runtime attempt is authoritative over the manifest hint. On API failure, the system branches on operation class:
- **Read or API-vs-API:** silent browser fallback allowed, record `path=browser`, `pathReason=api_failed_fell_back`.
- **Write via UI on a client system:** fallback permitted **only** if the task carries the opt-in marker; else **stop and escalate to human consent**, record `path=none`, `pathReason=api_failed_consent_required`.

Stale manifest handling: mark the entry **suspect** (advisory); never auto-delete, never auto-rewrite. Staleness surfaces as a recorded failure, never a silent success.

## Recording the path & reason into the session record

No new comment kind. The `decision` comment's artifact block (epic A `docs/superpowers/specs/2026-08-11-session-record-design.md:82-115`) gains two REQUIRED fields: `path` ∈ {`api`,`browser`,`none`} and `pathReason` (enum of `api_used`, `browser_used_no_api`, `api_failed_fell_back`, `api_failed_consent_required`).
Since `kind` is free text (`src/db/schema.ts:47`) and `decision` is an existing kind (`src/services/comments.ts:12`), there is zero schema change. The chosen path is auditable via the append-only events row for `comment.added` (`src/db/schema.ts:52-63`) — no new audit infra.

## How a task expresses 'browser fallback permitted'

Convention marker in the ticket body/task, mirroring the waiver pattern `src/forge/policy.ts:28-37`. Name it `ALLOW-BROWSER-WRITE:`. Reads and API paths need no marker; UI writes on a client system require it.
Consent gate mirrors the hard-block precedents: `src/services/tickets.ts:54-60` (`requiresVerification`) and the security finding refuse-to-run (`docs/findings/2026-08-11-security-testing-capability.md:166-188`). No marker + UI write → gate blocks, escalate to human. Not a warning — a hard stop.

## Artifact-block required fields per integration type

| Artifact Type | `id` | `trigger` | `table` | `target` | `channel` | `mapping` | `path` | `pathReason` |
|---|---|---|---|---|---|---|---|---|
| `zap` | required | required | optional | required | optional | optional | required | required |
| `workflow` | required | required | optional | optional | optional | required | required | required |
| `integration` | required | optional | optional | optional | optional | optional | required | required |
| `record` | required | optional | required | optional | optional | optional | required | required |
| `message` | required | optional | optional | required | required | optional | required | required |
| `other` | required | optional | optional | optional | optional | optional | required | required |

- `zap`: requires trigger and target to map the sequence exactly.
- `workflow`: requires trigger and mapping for generic flows.
- `integration`: minimal requirements, requires ID to match external system.
- `record`: requires table and ID to uniquely specify the entity.
- `message`: requires target and channel to route output.
- `other`: generic fallback, only ID and capability tracking are strictly enforced.

All types require `id` for objection (per epic A `docs/superpowers/specs/2026-08-11-session-record-design.md:106`); `path` and `pathReason` required for every type to track capability decisions.

### Worked Example — Zap Write Browser Fallback

```json
{
  "artifact": "zap",
  "id": "12345",
  "trigger": "airtable.record_created",
  "table": "Leads",
  "target": "slack.post_message",
  "channel": "#sales",
  "path": "browser",
  "pathReason": "api_failed_fell_back"
}
```
