export async function dialogAvailable(): Promise<boolean> {
  try {
    await import(/* @vite-ignore */ "@tauri-apps/plugin-dialog");
    return true;
  } catch {
    return false;
  }
}

export async function pickFolder(): Promise<string | null> {
  try {
    const { open } = await import(/* @vite-ignore */ "@tauri-apps/plugin-dialog");
    const result = await open({ directory: true });
    return typeof result === "string" ? result : null;
  } catch {
    return null;
  }
}
