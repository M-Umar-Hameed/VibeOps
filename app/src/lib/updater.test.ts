import { expect, test, vi, beforeEach } from "vitest";

const { check, ask, downloadAndInstall } = vi.hoisted(() => ({
  check: vi.fn(),
  ask: vi.fn(),
  downloadAndInstall: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask }));

import { checkForUpdate } from "./updater.js";

beforeEach(() => { check.mockReset(); ask.mockReset(); downloadAndInstall.mockClear(); });

// window.confirm resolves truthy inside the Tauri webview without ever asking,
// which auto-ran the installer on every boot. The check must go through the
// native ask() and respect a No.
test("declining the native dialog does not install", async () => {
  check.mockResolvedValue({ version: "0.1.2", currentVersion: "0.1.0", downloadAndInstall });
  ask.mockResolvedValue(false);
  await checkForUpdate();
  expect(ask).toHaveBeenCalledTimes(1);
  expect(downloadAndInstall).not.toHaveBeenCalled();
});

test("accepting installs", async () => {
  check.mockResolvedValue({ version: "0.1.2", currentVersion: "0.1.0", downloadAndInstall });
  ask.mockResolvedValue(true);
  await checkForUpdate();
  expect(downloadAndInstall).toHaveBeenCalledTimes(1);
});

test("no update means no dialog", async () => {
  check.mockResolvedValue(null);
  await checkForUpdate();
  expect(ask).not.toHaveBeenCalled();
});
