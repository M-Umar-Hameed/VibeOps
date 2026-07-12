# Default VibeOps Vault (Design Spec)

## Context

VibeOps can only attach to a pre-existing external vault: fresh installs have vault indexing dead until someone configures `obsidian.vault_path`, and there is no out-of-box home for the user's own markdown. Notes (P11) remain the structured, audited agent-memory layer; this slice gives human-authored markdown a first-class default location. Approved by the user ("start working on it").

## Design

- **`~/.vibeops/vault/`** is the default vault. `runBootstrap` creates it on every boot (idempotent `mkdirSync` BEFORE the existing-actors early return, so it also appears for installs that bootstrapped before this feature), and seeds a `README.md` starter note only when the file does not exist yet ("Drop markdown here — VibeOps indexes it automatically. Open this folder as an Obsidian vault if you like Obsidian; any editor works."). The vault lives inside the existing single backup unit.
- **Resolution chain** — one exported helper in `src/ingest/watch.ts`: `resolveVaultPath(homeDir?)` returns `await getSetting("obsidian.vault_path") ?? join(homeDir ?? homedir(), ".vibeops", "vault")`. `startWatcher` and `getVaultStatus` both use it (an explicit `customPath` still wins in `startWatcher`). When the resolved path is the default, `startWatcher` `mkdirSync`s it first (external-Postgres mode has no bootstrap).
- **Auto-start at boot**: `src/api/server.ts` fires `void startWatcher().catch(...)` after `applyEnvSettings()` (all modes) — fire-and-forget so the initial index never blocks boot; `startWatcher` already reports failures via `lastError`/`getVaultStatus` instead of throwing. Indexing becomes on-by-default; the UI stop/start buttons keep working (stop still stops; a stopped watcher stays stopped until started or next boot).
- **Settings semantics unchanged**: setting `obsidian.vault_path` still points at any external vault (e.g. `D:\Github\monorepo`); clearing it falls back to the default. Switching paths at runtime = stop + start with the new path (existing behavior).

## Approaches considered

1. **Default path + bootstrap dir + boot auto-start (chosen)** — reuses the entire existing watcher pipeline; no new machinery.
2. Two-way notes↔files sync — rejected: sync-conflict complexity for no gain; `search_knowledge` already spans both layers.
3. Multi-vault support (default + external simultaneously) — deferred; the watcher is single-path today and one setting flip covers the observed need.

## Error handling

Unchanged watcher contract: per-file failures logged and skipped; index failures land in `lastError`, visible via `GET /knowledge/obsidian`. Auto-start failure cannot crash boot (fire-and-forget + internal catch). Bootstrap vault-dir failure degrades like the credentials write (warn, continue).

## Testing

- `runBootstrap(port, tempDir)`: creates `tempDir/vault/` + starter `README.md`; second run leaves an edited starter file untouched; still idempotent for actors/credentials.
- `resolveVaultPath`: setting wins; default when unset (homeDir injectable for the test); explicit-arg precedence in `startWatcher` covered by existing tests.
- `tests/sidecar-payload.test.ts` gains one assertion: after boot with temp HOME, `<home>/.vibeops/vault/README.md` exists (proves bootstrap dir + auto-start path is live in the real payload).
- Live check (controller): boot dev server with fresh temp home → `GET /knowledge/obsidian` shows the default path with `isRunning: true`; drop an `.md` in, re-check `indexedCount`.

## Out of scope

Multi-vault, notes-to-file export, vault UI changes (the existing Obsidian card already shows path/status), file-edit attribution.
