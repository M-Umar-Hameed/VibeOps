# Board Roadmap Designs — 2026-07-15

Compact designs for every remaining open ticket, in build order. P19/P20/P21
have their own spec files (model-router, project-workspaces, council-intake).
Cost rule for all builds: haiku for transcription-grade tasks, sonnet for
integration, forge with agy-flash/agy-oss for UI work, findings-feedback
rework loops before any human fixes; opus review only at multi-ticket
checkpoints, not per ticket.

## 1. Context7 documentation connector (bf9e98b9)

Context7 (context7.com) serves version-current library docs over MCP/HTTP.
Opt-in per the ticket. Design: a knowledge SOURCE, not a proxy — new
`GET /knowledge/docs?library=<name>&topic=<q>` (member) that calls Context7's
public HTTP API (https://context7.com/api — verify current endpoint at build
time; free tier needs no key, paid key optional via settings key
`context7.apiKey`) and returns the doc snippets verbatim tagged
`sourceKind: "docs"`; NOT ingested into embeddings by default (docs churn and
would pollute recency ranking) — a `?save=1` flag upserts the response as a
`session`-style doc for offline reuse. Forge/relay prompts remain unchanged;
agents reach it through the existing search_knowledge MCP tool? No — separate
MCP tool `fetch_docs` added to the MCP server so agents pull docs on demand.
Settings toggle `context7.enabled` (default off). Tests mock fetch; no live
network in suite. Sonnet, ~half day.

## 2. Agent-pack plugin + reusable skills (c441e41a)

We now HAVE a skills marketplace — the agent-pack is VibeOps dogfooding it:
a `vibeops-pack/` directory IN THIS REPO shaped as a Claude-plugin marketplace
(.claude-plugin/marketplace.json + one plugin `vibeops` with skills/):
- `vibeops-tickets`: SKILL.md teaching any agent the ticket workflow (claim →
  plan comment → report → review, optimistic versions, REST + MCP surfaces).
- `vibeops-knowledge`: search-first/save-after habits, /prime usage,
  note-writing conventions (the habit block, packaged).
- `vibeops-forge`: how to behave as a forge worker (no git commit, narration,
  REPORT:/VERDICT: contracts).
Install path: add the repo itself as a marketplace in the Plugins tab (URL or
local path once P20 lands). README section. Zero new server code — content
only. Haiku transcription from existing docs/AGENTS.md/README, ~2 hours.

## 3. Communication profiles from Humanizer and Caveman (de067e22)

Prompt-layer feature, not new infra: settings key `agents.commProfile` in
{off, caveman, humanizer} (default off). When set, forge/relay compose*
prompts append one short style block (~120 words): caveman = terse
technical-substance-only output rules (from the caveman plugin's rules);
humanizer = the anti-AI-slop rules (no inflated symbolism, no rule-of-three,
plain attribution). Implementation: `src/relay/style.ts` exporting
`styleClause(profile)`; runs.ts appends to work/plan prompts (review prompts
STAY neutral — verdicts must not be style-constrained). UI: dropdown in
Settings → AI Models tab. Tests: clause selection + prompt contains block.
Haiku, ~2 hours.

## 4. Superpowers + Ponytail workflow policies (0cd538e5)

Two deliverables: (a) skills in the agent-pack (above) — `vibeops-sdd` skill
distilling the SDD loop (spec → plan → implementer → reviewer gate → fix →
re-review) and `vibeops-ponytail` (the laziness ladder), so ANY agent working
tickets follows the methodology; (b) forge enforcement hook: work prompts
gain one policy line when `agents.workflowPolicy=sdd` setting is on ("Follow
the plan exactly; smallest diff that satisfies acceptance criteria; leave one
runnable check"). No engine changes. Builds on 2+3 patterns. Haiku, ~2 hours.

## 5. Platform connectors: GitLab, Jira, Asana (f8f525be)

The `SourceConnector` interface + runSync engine already exist (P4, GitHub
proven). Per connector: map external issue → ticket (idempotent via
sync_links, incremental cursor, comments via sync_comment_links). Order:
GitLab first (closest to GitHub; PAT + REST v4), then Jira Cloud (email+token
basic auth, JQL updated>cursor), Asana last (PAT, workspace/project scoping).
Each = one `src/sync/<name>.ts` + fixture-driven tests (NO live API in suite)
+ settings keys `<name>.{token,baseUrl,project}` + CLI wiring in sync/cli.ts.
Credentials in settings DB (values write-only in UI). One sonnet subagent per
connector, sequential, ~half day each. GATED: needs the owner to test live
with real credentials before closing each.

## 6. Desktop hardening (d56ae862)

Sub-items, mostly owner-gated:
- Cache-vs-fresh token split in agents panel: code-only, sonnet (~2h) — read
  cache_read vs fresh from claude usage deltas, two columns in AgentsCard.
- Key revocation UI: `PATCH /actors/:id { revoked: true }` (admin; migration
  0008 additive `actors.revoked boolean default false`; auth middleware
  rejects revoked) + button in ActorsCard. Sonnet ~3h.
- Auto-updater: tauri-plugin-updater wired to a GitHub Releases feed; needs
  signing keys (tauri signer generate) — config + docs, OWNER runs keygen.
- Code signing: OWNER must buy an OV/EV cert (or use Azure Trusted Signing);
  we wire tauri.conf signing config + docs only.
- macOS verify: OWNER needs a Mac (or CI); we prep a GitHub Actions workflow
  building the app on macos-latest as a smoke.
Build the two code items now; wire configs for the rest with docs; ticket
stays open annotated "owner actions pending".

## 7. Release acceptance (4bcf156e)

Not a design — a gate. Checklist (executed when owner says ship): fresh
`tauri build`; clean-VM silent install; first-boot bootstrap (creds file,
vault seeded, migrations incl. 0006+); Forge pipeline e2e on a throwaway
ticket with agy; Plugins tab installs a real skill; /prime returns; uninstall
leaves no orphan process; README quickstart followed verbatim by a fresh
shell. Owner runs or delegates; results posted to the ticket.

## Build order (autonomous run)

P19 router → P20 workspaces → P21 council → agent-pack (2) → comm profiles (3)
→ superpowers policies (4) → Context7 (1) → hardening code items (6a/6b) →
GitLab connector (5, then pause for owner creds) → hardening owner-gated wiring
→ release acceptance awaits owner.
