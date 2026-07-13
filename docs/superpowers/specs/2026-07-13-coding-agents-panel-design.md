# Coding Agents Panel — Accounts + Observed Token Usage (Design Spec)

## Context

The Token Usage dashboard currently mocks "provider token quotas" (Claude/Antigravity/Codex) with fabricated limits and reset timers. Two problems: (1) it shows no *accounts* — the user can't see which login authenticates which agent; (2) the token numbers and quota limits are fake. This slice makes the coding-agent side real, and honest about what VibeOps cannot know. User approved ("yeah work on it").

## What is / isn't knowable (grounds every decision below)

Verified on this machine:
- **Accounts — real, on disk.** Codex: `~/.codex/auth.json` → `auth_mode` + `tokens.id_token` (JWT, `email` claim). Claude: `~/.claude.json` → `oauthAccount.{emailAddress, displayName, seatTier, organizationName, userRateLimitTier}`. Antigravity: `state.vscdb` key `antigravityUnifiedStateSync.oauthToken` decodes to a protobuf carrying `signedIn` state but **no email** — best-effort "Signed in (account not exposed)".
- **Coding-agent token usage — real, from transcripts VibeOps already ingests (P10).** Claude Code jsonl assistant lines carry `message.usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}` (per-turn deltas → sum). Codex rollout `event_msg:token_count` carries `info.total_token_usage.total_tokens` (cumulative running total → take the max per session file, then sum across files). Antigravity transcripts carry no token counts → null.
- **NOT knowable: provider quotas + reset timers.** The "200k / 5h", weekly limits, and "resets in" live server-side per account with Anthropic/OpenAI/Google. VibeOps has no access. The UI must show *observed usage*, never a fake "% of limit".

## Design

### Backend — `src/system/agents.ts` (new)

Pure-ish readers, each with an injectable base dir for testing; a reader NEVER throws (missing/unreadable file → `connected:false`, tokens 0). **Secrets never leave the process**: return only the account email + auth mode + plan; never the id_token, access_token, refresh_token, or API key. Never log token material.

- `readClaudeAccount(homeDir?)` → `{ agent:"claude", connected, account, plan, authMode:"oauth" }` from `~/.claude.json` `oauthAccount` (account=`emailAddress`, plan=`seatTier`).
- `readCodexAccount(homeDir?)` → `{ agent:"codex", connected, account, authMode }` from `~/.codex/auth.json` (account = `email` claim decoded from `tokens.id_token`; authMode = `auth_mode`).
- `readAntigravityAccount()` → `{ agent:"antigravity", connected, account:null, authMode:"oauth", note:"account not exposed locally" }` — read `state.vscdb` oauthToken via `process.getBuiltinModule("node:sqlite")` (vite-node can't import node:sqlite — same trick as the claude-mem reader); `connected` = oauthToken present & decodes to `signedIn`.
- `sumClaudeTokens(sinceDays, homeDir?)` → `{ inputTokens, outputTokens, totalTokens, sessions }` summing `message.usage` deltas across `~/.claude/projects/**/*.jsonl` within the mtime window (reuse the walk shape from the P10 claude-code reader).
- `sumCodexTokens(sinceDays, homeDir?)` → same shape; per rollout file take the LAST/max `total_token_usage.total_tokens` (cumulative), sum across files.
- `getAgents(sinceDays)` → assembles `{ sinceDays, agents: [ {…account…, tokens:{…}|null } ] }` for claude, codex, antigravity.

### REST — `GET /system/agents?sinceDays=` (admin-gated)

Reads OAuth identity from disk → `requireAdmin` (consistent with the other host-reading routes: settings, logs, ingest). Default `sinceDays=7`. Returns `getAgents`. Members get 403.

### Frontend — `AIUsageTab.tsx`

Replace the mock "PROVIDER TOKEN QUOTAS" section with a real **Coding Agents** panel (react-query on `/system/agents`, `api.get` returns the body directly — no `res.data`):
- One row per agent: icon, name, **account** (email / "Signed in" / "Not connected"), plan when present, and **observed tokens (last 7d)**: total, with input/output split; "—" when the agent exposes no counts (Antigravity).
- A single honest caption on the panel: "Usage observed by VibeOps from local session logs. Provider quotas and reset limits live with each provider and aren't visible here."
- No fake percentage bars / reset timers. A bar only if we later have a real denominator (we don't now).
- The existing `ai_usage_logs`-backed "knowledge/provider" section: keep, but its empty state must read "No usage logged yet" rather than falling back to convincing mock numbers (kills the misleading fallback flagged earlier).

## Approaches considered

1. **Read local auth + transcript tokens (chosen)** — real, zero cloud, uses data already on disk / already ingested.
2. Provider billing APIs per account — VibeOps doesn't hold those agents' OAuth creds and some providers expose no usage API; can't do it.
3. Keep mock, just add account labels — rejected; leaves fake numbers presented as real.

## Error handling

Every reader missing-file/parse-safe → `connected:false`, tokens null. Route never 500s on a missing agent. Antigravity sqlite unreadable → connected:false. Frontend renders "Not connected" per agent independently.

## Testing

- `src/system/agents.ts` unit tests with fixture dirs: claude account parsed from a fixture `.claude.json`; codex email decoded from a hand-built id_token (base64 payload with `email`); missing files → connected:false; `sumClaudeTokens` sums usage deltas across two fixture jsonl files, mtime window excludes an old file; `sumCodexTokens` takes max cumulative per file. **Assert no token/secret field appears in any returned object.**
- REST: `GET /system/agents` → member 403, admin 200 with the agents array shape; 401 keyless.
- App: Coding Agents panel renders accounts + token totals from a mocked `/system/agents`; the honest caption is present; Antigravity row shows "—" for tokens.

## Out of scope

Provider quota fetching (impossible), Gemini-CLI/Cursor agents (not requested; add later behind the same reader shape), historical token charts, writing `ai_usage_logs` from VibeOps' own LLM calls (separate ticket), decoding Antigravity's account email (not present locally).
