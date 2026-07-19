# Releasing VibeOps

## Updater keys: where each half goes

`npx tauri signer generate` produces a keypair. The two halves have very different handling:

- **Private key + its password: never enter this repository.** Not in `.env`, not in `.env.example`, not in `tauri.conf.json`, not in any committed file. Keep them in your password manager, and add them to GitHub Actions secrets as `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` for CI builds. For local release builds, set the same two names as environment variables in the shell that runs `tauri build` — the Tauri CLI reads them automatically. Losing this key means shipped apps can never verify another update; treat it like a code-signing cert.
- **Public key: committed to the repo.** It goes in `app/src-tauri/tauri.conf.json` under `plugins.updater.pubkey`, next to the update-manifest `endpoints` URL, once an update-hosting location exists (GitHub Releases works: point the endpoint at a `latest.json` asset). Until an endpoint exists, leave the updater unconfigured — a pubkey without an endpoint does nothing.

Enable order when ready: add `tauri-plugin-updater` (Cargo + builder + capability, same pattern as the dialog plugin), set `pubkey` + `endpoints`, export the two env vars, build. The build output then includes `.sig` files that shipped apps verify against the committed pubkey.

## Releasing on macOS

## Triggering a Build
The macOS build pipeline can be triggered in two ways:
1. Manually via **workflow_dispatch** in the GitHub Actions tab.
2. Automatically by pushing a tag starting with `v` (e.g., `v1.0.0`).

## Running the Unsigned App
The current CI pipeline builds an unsigned `.app` bundle for macOS. When you download the artifact and attempt to run it, macOS Gatekeeper may block it.
To open the unsigned app:
1. Right-click the `.app` file and select **Open**.
2. Or, run `xattr -cr /path/to/VibeOps.app` in the terminal to remove the quarantine attribute.

## Future Signing Steps (Owner TODOs)
To distribute a signed and notarized app with auto-update support, the owner needs to perform the following steps:
1. **Cert Import**: Add Apple Developer certificates and credentials to GitHub Secrets (`APPLE_CERTIFICATE`, `APPLE_ID`, `TAURI_SIGNING_PRIVATE_KEY`).
2. **Notarytool**: Ensure the Apple credentials are correct so `tauri` can automatically notarize the app.
3. **Updater Keygen**: Generate Tauri signing keys using `npx tauri signer generate`.
4. **Tauri Config**: Add the updater endpoint and the generated public key to `app/src-tauri/tauri.conf.json`.

## Windows Installer Notes
The NSIS installer automatically closes any running `VibeOps.exe` and `node.exe` sidecar from the install directory before installing over an existing install — no manual close needed.
