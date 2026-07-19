// Boot-time update check. Silent when up to date or when the updater is
// unavailable (dev server, plain browser, no endpoint reachable).
export async function checkForUpdate(): Promise<void> {
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return;
    const ok = window.confirm(
      `VibeOps ${update.version} is available (you have ${update.currentVersion}). Install now?`
    );
    if (!ok) return;
    // On Windows the NSIS installer takes over from here — its pre-install
    // hook closes the running app, so no explicit relaunch is needed.
    await update.downloadAndInstall();
  } catch {
    // updater not available here — never block the app over it
  }
}
