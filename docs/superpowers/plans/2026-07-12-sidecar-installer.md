# Sidecar + Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** One installable artifact: the Tauri app ships a portable Node + esbuild-bundled server + PGlite assets + migrations as resources, spawns the server on launch (probe-first), kills it on exit. Windows NSIS verified live; Linux payload verified on WSL Ubuntu (no system Node); deb/AppImage config shipped.

**Architecture:** `scripts/build-server.mjs` (esbuild, PGlite external, copies pglite pkg + drizzle) and `scripts/fetch-node.mjs` (official portable Node per target) write into `app/src-tauri/resources/`. Rust probes 127.0.0.1:8787; if free, spawns `<node> <server.cjs>` with `DATABASE_URL` stripped and `VIBEOPS_MIGRATIONS_DIR` set; kills the child on exit. The server's only code change: migrations path honors `VIBEOPS_MIGRATIONS_DIR` (CJS-bundle safety).

**Spec:** `docs/superpowers/specs/2026-07-12-sidecar-installer-design.md`

## Global Constraints

- Frontend: ZERO changes (Phase 5 auto-detect is the readiness story).
- `@electric-sql/pglite` must stay EXTERNAL to the bundle and ship as a real package dir (WASM asset resolution).
- Child env: `DATABASE_URL` REMOVED (stray env must not hijack embedded mode); `PORT=8787`, `VIBEOPS_MIGRATIONS_DIR=<resources>/server/drizzle` set. Nothing else added.
- Probe-then-spawn: an occupied 8787 means NO spawn (dev server / second instance / external deploy).
- Installer/uninstaller never touches `~/.vibeops`.
- Existing suites stay green. No emojis; minimal comments/logs. Windows paths: portable node binary is `node.exe` on win, `bin/node` in linux tarballs.
- Resources dirs are build artifacts: `.gitignore` `app/src-tauri/resources/`.

## File Structure

- `src/db/client.ts` — migrations dir env override (one line).
- `scripts/build-server.mjs`, `scripts/fetch-node.mjs` — new.
- `package.json` — `"build:sidecar"` script; esbuild pinned as devDependency.
- `app/src-tauri/tauri.conf.json` — productName VibeOps, resources, targets.
- `app/src-tauri/src/lib.rs` — supervision.
- `tests/sidecar-payload.test.ts` — boots the built payload in isolation.

---

### Task 1: Bundle-safe migrations + build-server script + payload smoke test

**Files:**
- Modify: `src/db/client.ts`, `package.json`
- Create: `scripts/build-server.mjs`, `tests/sidecar-payload.test.ts`, `.gitignore` entry

**Interfaces:**
- `client.ts`: migrations folder = `process.env.VIBEOPS_MIGRATIONS_DIR ?? fileURLToPath(new URL("../../drizzle", import.meta.url))`.
- `node scripts/build-server.mjs [--out <dir>]` → writes `<out>/{server.cjs, node_modules/@electric-sql/pglite/**, drizzle/**}`; default out `dist-server/`.

- [ ] **Step 1:** `src/db/client.ts` — change line 30 to:
```ts
  const migrationsDir = process.env.VIBEOPS_MIGRATIONS_DIR
    ?? fileURLToPath(new URL("../../drizzle", import.meta.url));
  await migrate(d as never, { migrationsFolder: migrationsDir });
```
- [ ] **Step 2:** Pin `"esbuild": "^0.19.12"` in root devDependencies (already transitively present; make it explicit). `npm install`.
- [ ] **Step 3:** Write `scripts/build-server.mjs`:

```js
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : "dist-server";

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: ["src/api/server.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: join(outDir, "server.cjs"),
  external: ["@electric-sql/pglite"],
  logLevel: "info",
});

cpSync("node_modules/@electric-sql/pglite", join(outDir, "node_modules", "@electric-sql", "pglite"), { recursive: true });
cpSync("drizzle", join(outDir, "drizzle"), { recursive: true });
console.log(`payload ready: ${outDir}`);
```
Note: if esbuild chokes on `import.meta.url` under CJS output, it rewrites it to a shim automatically for format cjs — but the migrations path no longer depends on it when `VIBEOPS_MIGRATIONS_DIR` is set (the launcher always sets it). If OTHER `import.meta` usages in the server graph break the CJS build (e.g. `pathToFileURL(process.argv[1])` guards — those are runtime, fine), report specifics rather than switching to ESM output blindly; ESM output (`format:"esm"`, `server.mjs`, plus `banner` createRequire shim for pglite require) is the fallback — pick whichever compiles AND boots, note it.

- [ ] **Step 4:** Add root script `"build:sidecar:server": "node scripts/build-server.mjs"`. `.gitignore`: add `dist-server/` and `app/src-tauri/resources/`.
- [ ] **Step 5:** Write `tests/sidecar-payload.test.ts` — builds (execSync the script) then boots the payload ISOLATED (temp HOME so it never touches the real `~/.vibeops`):

```ts
import { expect, test } from "vitest";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("built sidecar payload boots embedded and serves 401", { timeout: 120_000 }, async () => {
  execSync("node scripts/build-server.mjs --out dist-server", { stdio: "inherit" });
  expect(existsSync("dist-server/server.cjs")).toBe(true);
  expect(existsSync("dist-server/node_modules/@electric-sql/pglite/package.json")).toBe(true);
  expect(existsSync("dist-server/drizzle")).toBe(true);

  const home = mkdtempSync(join(tmpdir(), "vibeops-home-"));
  const env = { ...process.env, PORT: "18787", VIBEOPS_MIGRATIONS_DIR: resolve("dist-server/drizzle"), HOME: home, USERPROFILE: home };
  delete (env as any).DATABASE_URL;
  delete (env as any).VITEST;
  const child = spawn(process.execPath, [resolve("dist-server/server.cjs")], { env, stdio: "pipe" });
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch("http://127.0.0.1:18787/projects");
        if (res.status === 401) { up = true; break; }
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(up).toBe(true);
    expect(existsSync(join(home, ".vibeops", "credentials.json"))).toBe(true);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    rmSync(home, { recursive: true, force: true });
  }
});
```
Note: the child env deletes `VITEST` so the payload takes the EMBEDDED branch (the test runner exports VITEST=true into process.env, which would otherwise leak in and point the child at :5433).

- [ ] **Step 6:** Run `npm test -- sidecar-payload` (must pass — this IS the payload proof), FULL `npm test`, `npm run typecheck`. Commit: `feat: bundle-safe migrations path and sidecar server payload build`.

---

### Task 2: Portable-Node fetcher

**Files:**
- Create: `scripts/fetch-node.mjs`
- Modify: `package.json` (script)

**Interfaces:**
- `node scripts/fetch-node.mjs --target win-x64|linux-x64 [--out <dir>]` → places the node binary at `<out>/<target>/node.exe` (win) or `<out>/<target>/node` (linux, chmod +x where applicable). Default out `app/src-tauri/resources/node`. Skips download when the binary already exists. Node version pinned `22.14.0` (LTS; any active LTS fine — pin one).

- [ ] **Step 1:** Write `scripts/fetch-node.mjs`:

```js
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { execSync } from "node:child_process";

const VERSION = "22.14.0";
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const target = arg("--target", "win-x64");
const outRoot = arg("--out", "app/src-tauri/resources/node");
const outDir = join(outRoot, target);
const binName = target.startsWith("win") ? "node.exe" : "node";
const binPath = join(outDir, binName);

if (existsSync(binPath)) { console.log(`cached: ${binPath}`); process.exit(0); }
mkdirSync(outDir, { recursive: true });

const base = `https://nodejs.org/dist/v${VERSION}`;
const name = `node-v${VERSION}-${target}`;
const url = target.startsWith("win") ? `${base}/${name}.zip` : `${base}/${name}.tar.xz`;
const archive = join(outDir, target.startsWith("win") ? "node.zip" : "node.tar.xz");

console.log(`downloading ${url}`);
const res = await fetch(url);
if (!res.ok) throw new Error(`download failed: ${res.status}`);
await pipeline(res.body, createWriteStream(archive));

if (target.startsWith("win")) {
  execSync(`tar -xf "${archive}" -C "${outDir}" ${name}/node.exe`, { stdio: "inherit" });
  renameSync(join(outDir, name, "node.exe"), binPath);
} else {
  execSync(`tar -xJf "${archive}" -C "${outDir}" ${name}/bin/node`, { stdio: "inherit" });
  renameSync(join(outDir, name, "bin", "node"), binPath);
  try { chmodSync(binPath, 0o755); } catch {}
}
rmSync(join(outDir, name), { recursive: true, force: true });
rmSync(archive, { force: true });
console.log(`ready: ${binPath}`);
```
(Windows 10+ ships bsdtar as `tar`, which reads zip AND tar.xz — one extraction path. If `tar -xJf` fails for xz on this machine, extract the linux tarball inside WSL instead and note it.)

- [ ] **Step 2:** Root script: `"build:sidecar:node": "node scripts/fetch-node.mjs --target win-x64 && node scripts/fetch-node.mjs --target linux-x64"`.
- [ ] **Step 3:** Run it; verify both binaries exist (`app/src-tauri/resources/node/win-x64/node.exe`, `.../linux-x64/node`). Run the win one: `app/src-tauri/resources/node/win-x64/node.exe -v` → `v22.14.0`. Commit: `feat: portable node fetcher for sidecar targets`.

---

### Task 3: Tauri packaging config

**Files:**
- Modify: `app/src-tauri/tauri.conf.json`, root `package.json`

- [ ] **Step 1:** `tauri.conf.json`: `productName` → `"VibeOps"`; `bundle.targets` → `["nsis", "deb", "appimage"]`; add `bundle.resources`: `["resources/server/**/*", "resources/node/**/*"]` (verify against Tauri 2 resources schema — map-form `{"resources/server": "resources/server"}` if glob form misbehaves; pick what `cargo tauri build` accepts).
- [ ] **Step 2:** Root orchestration script: `"build:sidecar": "npm run build:sidecar:server -- --out app/src-tauri/resources/server && npm run build:sidecar:node"`.
  NOTE: npm passes `-- --out ...` through only with exact quoting — simpler: make `build:sidecar` call node directly: `"build:sidecar": "node scripts/build-server.mjs --out app/src-tauri/resources/server && node scripts/fetch-node.mjs --target win-x64 && node scripts/fetch-node.mjs --target linux-x64"`.
- [ ] **Step 3:** Run `npm run build:sidecar`; verify the three resource trees exist. In `app/`: `npx tsc --noEmit` + `npm run build` (unchanged frontend must still build). Commit: `feat: tauri packaging config with sidecar resources`.

---

### Task 4: Rust supervision

**Files:**
- Modify: `app/src-tauri/src/lib.rs`

**Interfaces:**
- Behavior: setup → if TCP connect to 127.0.0.1:8787 succeeds within ~300ms, spawn nothing; else resolve resource paths and spawn; on exit, kill child.

- [ ] **Step 1:** Rewrite `lib.rs`:

```rust
use std::net::TcpStream;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::path::BaseDirectory;
use tauri::Manager;

struct Sidecar(Mutex<Option<Child>>);

fn port_in_use() -> bool {
    TcpStream::connect_timeout(&"127.0.0.1:8787".parse().unwrap(), Duration::from_millis(300)).is_ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            if port_in_use() {
                return Ok(()); // dev server / other instance already serving
            }
            let resources = app.path().resolve("resources", BaseDirectory::Resource)?;
            let node = if cfg!(windows) {
                resources.join("node").join("win-x64").join("node.exe")
            } else {
                resources.join("node").join("linux-x64").join("node")
            };
            let server = resources.join("server").join("server.cjs");
            let migrations = resources.join("server").join("drizzle");
            if !node.exists() || !server.exists() {
                eprintln!("sidecar resources missing; app will use Settings fallback");
                return Ok(());
            }
            let mut cmd = Command::new(&node);
            cmd.arg(&server)
                .env_remove("DATABASE_URL")
                .env("PORT", "8787")
                .env("VIBEOPS_MIGRATIONS_DIR", &migrations);
            match cmd.spawn() {
                Ok(child) => { *app.state::<Sidecar>().0.lock().unwrap() = Some(child); }
                Err(e) => eprintln!("sidecar spawn failed: {e}"),
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = app.state::<Sidecar>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
```
Adapt to the installed Tauri 2 API if names differ (`app.path().resolve`, `RunEvent::Exit`) — compile is the arbiter. On Windows, consider `CREATE_NO_WINDOW` (0x08000000) via `std::os::windows::process::CommandExt::creation_flags` so no console flashes — add it behind `#[cfg(windows)]`.

- [ ] **Step 2:** `export PATH="$HOME/.cargo/bin:$PATH"; cargo check` in `app/src-tauri` — clean. App suite (`npm test` in app/) unchanged/green. Commit: `feat: sidecar server supervision in tauri shell`.

---

### Task 5: Build, live acceptance, docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1 (controller-run):** `npm run build:sidecar`, then in `app/`: `npm run tauri build` (NSIS target). Artifact under `app/src-tauri/target/release/bundle/nsis/*.exe`.
- [ ] **Step 2 (controller-run, Windows live):** stop any running dev server; install the NSIS exe; launch VibeOps from the Start menu: sidecar spawns (node.exe child), app auto-connects, ticket round-trip; quit the app → node.exe gone (no orphan).
- [ ] **Step 3 (controller-run, WSL live):** copy `app/src-tauri/resources/server` + `resources/node/linux-x64/node` into WSL Ubuntu (no system Node); run `PORT=18787 VIBEOPS_MIGRATIONS_DIR=.../server/drizzle ./node server/server.cjs`; curl 401 + credentials.json in the WSL home. Proves the linux payload.
- [ ] **Step 4:** README: "Install (one file)" section — download/build the installer, what launch does (spawns its own server unless one is already running on 8787), where data lives (`~/.vibeops`, untouched by uninstall), and the dev-mode note (running `npm run dev` first means the app attaches to it instead of spawning). Linux: deb/appimage config present; payload verified on Ubuntu; full bundles best-effort.
- [ ] **Step 5:** Full gates: root suite, app suite, typechecks. Commit: `docs: one-file install and sidecar behavior`.

## Acceptance

- `tests/sidecar-payload.test.ts` green (payload boots isolated, bootstraps, serves 401 keyless).
- Windows: installed NSIS artifact runs the full loop (spawn → auto-connect → ticket → clean kill on quit).
- WSL Ubuntu (no Node): shipped payload serves + bootstraps.
- Suites + typechecks green; frontend untouched; `~/.vibeops` untouched by install/uninstall.

## Self-review notes (done)

- The one server change (migrations env override) is Task 1 Step 1 and covered by the payload test (env set) AND the existing embedded-db test (env unset → import.meta fallback).
- VITEST leak into the payload child env identified and deleted in the test (would silently point the child at :5433).
- esbuild CJS vs import.meta risk: fallback to ESM output documented with the createRequire caveat; compile+boot is the arbiter, implementer reports which.
- fetch-node uses Windows bsdtar for both archive types; WSL fallback documented.
- Rust: probe-then-spawn covers dev mode + PGlite single-process; child killed on Exit; resources-missing and spawn-fail degrade to the existing Settings fallback. CREATE_NO_WINDOW noted.
- Ponytail: no auto-restart, no health loop in Rust, no code signing, no SEA.
