# Sidecar + Installer (Design Spec)

## Context

Standalone v1 (Phase 5) removed Docker and manual setup, but running VibeOps still means `npm run dev` in a terminal plus `tauri:dev` — developer ergonomics, not vibecoder ergonomics. This slice bundles the server INTO the desktop app: install one artifact, launch the app, everything runs. The embedded PGlite + auto-bootstrap + credentials auto-detect from Phase 5 do all the heavy lifting; this slice only packages and supervises.

Packaging decision (brainstormed): **portable Node + bundled server shipped as Tauri resources**, spawned by the Rust shell — not a compiled single-binary sidecar (Node SEA / bun-compile risks a fight with PGlite's runtime WASM loading for purely cosmetic gain; revisit later without touching anything but packaging). Platforms: **Windows (fully verified live)** + **Linux (payload verified on WSL Ubuntu 26.04; bundle config shipped, full build best-effort)**; macOS config present but explicitly unverified.

## Scope of this slice

- esbuild server bundle + PGlite/migrations payload + portable-Node fetcher.
- Tauri resource bundling, NSIS (Windows) + deb/AppImage (Linux) targets.
- Rust process supervision: probe-then-spawn on launch, kill on exit.
- Live acceptance: install the NSIS artifact on this machine; run the payload on WSL Ubuntu (which has no Node — the true vibecoder test).
- Out of scope: single-binary sidecar (SEA/bun), macOS verification, auto-updater, code signing, bundling the vault watcher / sync CLI / MCP server into the app (they remain repo commands; the MCP server one-click config is its own queued slice).

## Architecture

### Server payload (`scripts/build-server.mjs`)
- esbuild: entry `src/api/server.ts` → `dist-server/server.cjs` (single CJS file, `platform: "node"`, `format: "cjs"`, minify off for debuggability).
- `@electric-sql/pglite` marked **external** — it is dependency-free but resolves its WASM/fs-bundle assets relative to its own package directory; bundling breaks that. The script copies `node_modules/@electric-sql/pglite` → `dist-server/node_modules/@electric-sql/pglite` so `require` resolves it normally at runtime.
- Copies `drizzle/` → `dist-server/drizzle/` and the bundle locates migrations relative to itself. NOTE (implementation-critical): `src/db/client.ts` resolves the migrations folder via `import.meta.url`; under the CJS bundle this must be made bundle-safe (e.g. resolve from `__dirname` when bundled, or an env override `VIBEOPS_MIGRATIONS_DIR` set by the launcher). The plan pins the exact mechanism.
- Output tree is exactly what ships: `dist-server/{server.cjs, node_modules/@electric-sql/pglite/**, drizzle/**}`.

### Portable Node (`scripts/fetch-node.mjs`)
- Downloads the official Node LTS portable build per target — `node-v*-win-x64.zip`, `node-v*-linux-x64.tar.xz` — extracts ONLY the node binary into `app/src-tauri/resources/node/<target>/`. Cached (skip if present); not committed (.gitignore).

### Tauri packaging (`app/src-tauri/tauri.conf.json`)
- `bundle.resources`: `resources/server/**` (the dist-server tree, copied in by the build script) + `resources/node/**`.
- Targets: `nsis` (Windows), `deb` + `appimage` (Linux). Version/productName already VibeOps.

### Rust supervision (`app/src-tauri/src/lib.rs`)
- On setup: TCP-probe `127.0.0.1:8787`. Occupied → spawn nothing (dev server or external deploy already running; the app connects to it as today).
- Free → resolve resource paths, spawn `<node> <server.cjs>` with env: `PORT=8787`, `EMBED_PROVIDER` passed through (unset = fake is NOT implied; server default embedder is voyage — launcher sets `EMBED_PROVIDER=fake` unless the user configured a key... NO: keep truthful — launcher sets nothing except PORT and `VIBEOPS_MIGRATIONS_DIR`; the server's knowledge features require embedder config only when used. The plan verifies which endpoints touch the embedder at boot: none — `getEmbedder()` is called lazily per request, so the server boots keyless and only knowledge search/save require config).
- Explicitly REMOVE `DATABASE_URL` from the child env (embedded mode must not be hijacked by a stray user env var pointing at a dead Postgres).
- Store the child handle; kill it on `RunEvent::Exit`/window destroy. Log spawn failures to the Tauri log; the app's existing "can't reach server → Settings" flow is the user-facing fallback.
- The frontend needs zero changes: existing credentials auto-detect + retry handles readiness.

### Dev vs packaged
- `tauri:dev` continues to work unchanged (probe finds the dev server if running, or spawns the built payload if `dist-server` exists, else app falls back to Settings).
- Single-instance concern: PGlite is single-process. Probe-then-spawn means a second app launch attaches to the first instance's server rather than double-spawning.

## Error handling

- Spawn failure (missing resources, exec denied) → logged; app shows the existing unreachable-server Settings flow. Never crashes the app.
- Server crash mid-session → app requests fail with the existing banners; relaunching the app re-probes and re-spawns. No auto-restart loop in v1 (supervision creep — deferred).
- Port occupied by a non-VibeOps process → probe assumes "server present"; the app's 401/detect flow surfaces the mismatch naturally (documented).

## Testing / acceptance

- Script-level: `build-server.mjs` output sanity (bundle + pglite + drizzle present); a Node smoke run of `dist-server/server.cjs` with a temp `VIBEOPS_HOME`-style isolation if cheap, else the live checks below carry it.
- **Windows live (blocking)**: `tauri build` → install the NSIS `.exe` → launch: sidecar spawns, embedded DB boots + bootstraps, app auto-connects, ticket create/read round-trip; quitting the app kills the server (no orphan node.exe).
- **Linux live (blocking, payload-level)**: copy `dist-server` + linux portable node into WSL Ubuntu (no system Node) → run server → credentials written, HTTP round-trip via curl. Proves the shipped payload is genuinely cross-platform.
- Linux full bundle (deb/appimage): attempted in WSL only if the webkit2gtk toolchain installs cleanly — NON-blocking.
- Existing suites must stay green (this slice adds scripts + Rust + config; server source changes limited to the migrations-path bundle-safety fix).

## Risks / notes

- Migrations-path resolution under the CJS bundle is the one real code change in the server — pinned in the plan, covered by the live boots.
- Portable Node adds ~80MB per platform to the installer. Accepted (correctness over size; SEA later if it matters).
- `~/.vibeops` stays the data home — installer/uninstaller must NOT touch it (backup/restore semantics from Phase 5 hold).

## Deferred
- Single-binary sidecar, macOS verification, code signing, auto-updater, server auto-restart, bundling watcher/sync/MCP processes.
