# Skills Marketplace (Phase 18) — Design

Date: 2026-07-14. Approved by owner: install into all agents' skill dirs; accept
both Claude Code marketplaces and plain skill repos; v1 is skills only.

## Purpose

A Plugins tab in VibeOps that manages agent skills the way Claude Code manages
plugins: add a marketplace by GitHub URL, browse the skills it offers, install /
uninstall / update them. Installed skills land in `~/.claude/skills/<name>` so
Claude CLI and agy pick them up natively, and Forge's `/`-autocomplete
(`GET /forge/skills`, which reads that dir) sees them with zero extra wiring.

## Model

- **Marketplace** = a public git repo URL (https only). Cloned shallow into
  `~/.vibeops/marketplaces/<sha1(url)>`; refresh = `git pull` (re-clone on
  pull failure). Arg-vector git via the same spawn pattern as forge/sandbox.
- **Skill** = a directory containing `SKILL.md` with optional YAML frontmatter
  (`name:`, `description:`). Discovery, in order:
  1. `.claude-plugin/marketplace.json` present → walk its `plugins[]` sources,
     collect `skills/*/SKILL.md` under each plugin dir (Claude Code format);
     skill is labeled `plugin:skill-dir-name`.
  2. Otherwise scan the repo for `*/SKILL.md` up to depth 3 (plain skill repo).
- **Install** = copy the skill dir to `~/.claude/skills/<dir-name>` (refuse if
  the target exists and was not installed by us). **Uninstall** = remove that
  dir. **Update** = refresh marketplace, re-copy installed skills from it.
- **Registry** = settings keys (existing settings DB): `skills.marketplaces`
  (JSON array of `{url, addedAt}`) and `skills.installed` (JSON array of
  `{name, dir, url, installedAt}`). No new tables.

## Routes (all `requireAdmin`)

- `GET  /skills/marketplaces` → `[{ url, skills: [{name, description, dir, installed}] }]`
  (scans the local clones; does not hit the network).
- `POST /skills/marketplaces { url }` → clones + scans; 400 on non-https or
  clone failure; idempotent on repeat URL (refreshes instead).
- `DELETE /skills/marketplaces` body `{ url }` → removes clone + registry entry
  (installed skills stay installed).
- `POST /skills/install { url, dir }` → copies the skill; 409 if target dir
  exists and isn't ours; records in registry.
- `POST /skills/uninstall { name }` → removes `~/.claude/skills/<name>` only if
  the registry owns it (never deletes user-authored skills); 404 otherwise.
- `GET  /skills/installed` → registry list, each flagged `present` (dir still
  exists).

## Frontend

New "Plugins" tab in Settings (alongside MCP / AI Models / AI Usage): a URL
input + "Add marketplace" button; a card per marketplace listing its skills
with name, description, and an Install / Installed(Uninstall) button; an
"Installed skills" section at top showing registry entries with source and
Uninstall. Errors inline. Uses the `api` facade (body returned directly).

## Security

- https URLs only; `git clone --depth 1` executes no repo code (no hooks run on
  clone/pull).
- Copy is confined: skill dir names sanitized to `[A-Za-z0-9._-]{1,64}`, target
  always directly under `~/.claude/skills`.
- Uninstall only touches dirs the registry recorded — a user's hand-written
  skills are never deletable through the API.
- Inherent and documented: a skill's SKILL.md is instructions to agents; a
  malicious marketplace is a prompt-injection vector, exactly as in Claude
  Code's own marketplaces. Trust the repos you add.

## Testing

- Discovery: fixture marketplace repos (one Claude-format with marketplace.json,
  one plain) in temp dirs — local `file://`-less clones use `git clone <path>`,
  which works arg-vector with a plain path.
- Install/uninstall lifecycle with a temp HOME override (`VIBEOPS_SKILLS_HOME`
  env for the skills root, mirroring VIBEOPS_SANDBOX_ROOT's pattern).
- Route authz (member 403) rows.
- Frontend tab tests mocking apiFetch.

## Out of scope (v1)

Hooks/commands/agents/MCP servers from plugins (listed as unsupported), skill
versioning/pinning, auto-update, private repos/auth, codex skill dir sync.
