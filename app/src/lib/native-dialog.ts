// Literal import so vite bundles the module — the old @vite-ignore variable
// specifier was never bundled, so production builds failed the import and
// Browse buttons silently hid. The package is a real dependency now; absence
// is only a test scenario (simulated via doMock).
export async function dialogAvailable(): Promise<boolean> {
  try {
    await import("@tauri-apps/plugin-dialog");
    return true;
  } catch {
    return false;
  }
}

export async function pickFolder(): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({ directory: true });
    return typeof result === "string" ? result : null;
  } catch {
    return null;
  }
}

export async function openRepoFolder(path: string): Promise<void> {
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
  } catch {
    // Non-tauri context (browser/test) or plugin missing — no-op.
  }
}
