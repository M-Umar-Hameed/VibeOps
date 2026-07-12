# Authorization Roles (Design Spec)

## Context

Authentication exists (per-actor sha256 bearer keys → audit attribution) but authorization does not: every key is owner-equivalent. Security reviews flagged the consequences (agents can read/write stored provider API keys, point vault indexing at arbitrary directories, write MCP client config files). Recon facts: `actors.role` has existed since migration 0000 (`text`, default `"member"`; bootstrap's owner actor gets `"admin"`) with ZERO enforcement; there is no REST route to create actors, so in practice every agent connects with the owner's key — which also undermines per-agent attribution, the core audit promise. User approved scope: owner/agent split, work surface stays collaborative.

## Design

Reuse the existing role values — `admin` (the bootstrap owner) and `member` (default) — no migration, no data backfill.

### Guard

`requireAdmin` middleware (in `src/api/auth.ts`, beside `auth`): reads `c.get("actor")`, throws new `ForbiddenError` (mapped to 403 in `app.onError`) unless `role === "admin"`. Applied per-route (explicit list, not a path pattern — auditable):

- `GET /settings/:key`, `PATCH /settings/:key` (stored provider API keys)
- `POST /knowledge/obsidian/start`, `POST /knowledge/obsidian/stop` (filesystem indexing control; `GET /knowledge/obsidian` status stays open — read-only health)
- `POST /mcp/install` (writes files on the host)
- `POST /ingest/sessions` (reads local session files into the index)
- `POST /actors` (new — key minting is privilege escalation if open)
- `GET /system/logs` (may carry sensitive operational detail; metrics/topology stay open)

Everything else — tickets, comments, notes, knowledge search/save/source, projects, search, `GET /mcp/config` (echoes only the caller's own key), `/mcp` tools — stays available to members: the collaborative work surface.

### Actor minting

`POST /actors` (admin-only): body `{ name, kind: "human" | "agent", role?: "admin" | "member" }` (role defaults `member`; only an admin can mint another admin — inherently true since the route is admin-only). Returns `{ actor, apiKey }` — the plaintext key appears exactly once in this response; only the hash is stored. Rejects invalid role values (400).

### MCP

`buildServer`'s tools are all work-surface — unchanged. `/mcp/config` + `/mcp/install` flow: an admin can mint an agent key, then generate that agent's MCP config by calling `GET /mcp/config` WITH the agent's key (config echoes the caller's key by design) — this finally gives each tool its own attributed identity.

### App UI (minimal)

`ActorsCard` component (new file) mounted in the Local Node settings tab (stable, not in the user's current WIP set): lists actors (name, kind, role — never key hashes), "New agent key" form (name → shows the returned key once with copy button + "store it now, it is not retrievable" note). 403s surface inline (member keys see the card fail gracefully).

## Approaches considered

1. **Route-list guard on existing role column (chosen)** — no migration, explicit auditable list, one middleware.
2. Scope/permission table per actor — real RBAC; YAGNI for a two-tier desktop threat model.
3. Guard at the service layer — deepest defense but touches every service signature (actor plumbed in but role checks scattered); route-level matches where the trust boundary is (HTTP) and MCP tools are all work-surface anyway.

## Error handling

`ForbiddenError` (`src/services/errors.ts`) → 403 `{ error }` in `app.onError`, before the generic 500. Guard runs after `auth`, so 401 (bad key) beats 403 (good key, wrong role).

## Testing

For each guarded route: member key → 403, admin key → non-403 (existing behavior). Member sanity: can still create a ticket, save/search knowledge. POST /actors: returns plaintext key once + role default member; member → 403; invalid role → 400; minted agent key authenticates and hits the work surface. App: ActorsCard renders list + create flow (mocked), 403 state.

## Out of scope

Per-row ownership, key rotation/revocation UI (list-only; revocation = delete actor, a later slice), scope tables, rate limiting, session expiry.
