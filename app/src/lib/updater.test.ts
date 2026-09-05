import { expect, test, vi, beforeEach } from "vitest";

const { check, ask, downloadAndInstall, apiFetch } = vi.hoisted(() => ({
  check: vi.fn(),
  ask: vi.fn(),
  downloadAndInstall: vi.fn(async () => {}),
  apiFetch: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask }));
vi.mock("../api/client.js", () => ({ apiFetch }));

import { checkForUpdate } from "./updater.js";

beforeEach(() => {
  check.mockReset(); ask.mockReset(); downloadAndInstall.mockClear(); apiFetch.mockReset();
  // Default: shutdown ok, then the server is immediately gone (port freed).
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/system/metrics") throw { unreachable: true };
    return { ok: true };
  });
});

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

test("accepting stops the sidecar before installing", async () => {
  check.mockResolvedValue({ version: "0.1.2", currentVersion: "0.1.0", downloadAndInstall });
  ask.mockResolvedValue(true);
  await checkForUpdate();
  expect(apiFetch).toHaveBeenCalledWith("/system/shutdown", { method: "POST" });
  const shutdownOrder = apiFetch.mock.invocationCallOrder[0];
  const installOrder = downloadAndInstall.mock.invocationCallOrder[0];
  expect(shutdownOrder).toBeLessThan(installOrder);
  expect(downloadAndInstall).toHaveBeenCalledTimes(1);
});

test("a missing/failing shutdown endpoint still installs", async () => {
  apiFetch.mockRejectedValue(Object.assign(new Error("nope"), { status: 404 }));
  check.mockResolvedValue({ version: "0.1.2", currentVersion: "0.1.0", downloadAndInstall });
  ask.mockResolvedValue(true);
  await checkForUpdate();
  expect(downloadAndInstall).toHaveBeenCalledTimes(1);
});

test("declining stops nothing and installs nothing", async () => {
  check.mockResolvedValue({ version: "0.1.2", currentVersion: "0.1.0", downloadAndInstall });
  ask.mockResolvedValue(false);
  await checkForUpdate();
  expect(apiFetch).not.toHaveBeenCalled();
  expect(downloadAndInstall).not.toHaveBeenCalled();
});

