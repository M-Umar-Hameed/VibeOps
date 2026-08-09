// True when running inside the Tauri webview. The plugins reach the native
// bridge through this same global, so its presence is the signal that plugin
// calls (store, http, fs) will work rather than throw.
export function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
