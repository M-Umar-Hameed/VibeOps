# Releasing VibeOps on macOS

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
