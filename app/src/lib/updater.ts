// Boot-time update check. Silent when up to date or when the updater is
// unavailable (dev server, plain browser, no endpoint reachable).
export async function checkForUpdate(): Promise<void> {
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return;
    // window.confirm is not a real prompt inside the Tauri webview - it
    // resolves truthy without asking, which auto-launched the installer on
    // every boot. Use the native dialog plugin, which actually asks.
    const { ask } = await import("@tauri-apps/plugin-dialog");
    const ok = await ask(
      `VibeOps ${update.version} is available (you have ${update.currentVersion}). Install now?`,
      { title: "VibeOps update", kind: "info" },
    );
    if (!ok) return;
    // Cleanly stop the sidecar first: it checkpoints the embedded DB and releases
    // the node.exe lock so the NSIS installer overwrites it without a force-kill
    // (which corrupts the DB) or a file-in-use error. Best-effort — a browser/dev
    // build with no reachable sidecar just falls through to the installer.
    await stopSidecar();
    // On Windows the NSIS installer takes over from here — its pre-install
    // hook closes the running app, so no explicit relaunch is needed.
    await update.downloadAndInstall();
  } catch {
    // updater not available here — never block the app over it
  }
}

async function stopSidecar(): Promise<void> {
  try {
    const { apiFetch } = await import("../api/client.js");
    await apiFetch("/system/shutdown", { method: "POST" });
    // Wait for the port to free so the installer never races a live node.exe.
    // Bounded (~10s) so a wedged server can't block the update forever.
    for (let i = 0; i < 40; i++) {
      try { await apiFetch("/system/metrics"); }
      catch (e) { if ((e as { unreachable?: boolean }).unreachable) return; }
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch {
    // no reachable sidecar, or /system/shutdown absent on an older server
  }
}

