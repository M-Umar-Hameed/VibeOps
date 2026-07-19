import { expect, test, vi } from "vitest";

// The plugin is bundled now, so the module RESOLVES in jsdom; only the IPC
// call inside open() can fail. Absent-plugin behavior is simulated per-test
// via vi.doMock + a fresh import.

test("dialogAvailable is true when the module resolves; pickFolder degrades to null without Tauri IPC", async () => {
  const { dialogAvailable, pickFolder } = await import("./native-dialog.js");
  expect(await dialogAvailable()).toBe(true);
  // jsdom has no Tauri backend: open() throws, pickFolder swallows to null.
  expect(await pickFolder()).toBe(null);
});

test("degrades gracefully when the plugin import itself fails", async () => {
  vi.resetModules();
  vi.doMock("@tauri-apps/plugin-dialog", () => {
    throw new Error("module not available");
  });
  const { dialogAvailable, pickFolder } = await import("./native-dialog.js");
  expect(await dialogAvailable()).toBe(false);
  expect(await pickFolder()).toBe(null);
  vi.doUnmock("@tauri-apps/plugin-dialog");
  vi.resetModules();
});
