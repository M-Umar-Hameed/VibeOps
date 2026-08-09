import { afterEach, expect, test, vi } from "vitest";

const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load }));

import { getSettings, saveSettings } from "./settings.js";

const INTERNALS = "__TAURI_INTERNALS__";

afterEach(() => {
  delete (window as any)[INTERNALS];
  load.mockReset();
  vi.unstubAllEnvs();
});

test("getSettings returns env defaults when Tauri bridge absent", async () => {
  delete (window as any)[INTERNALS];
  expect(await getSettings()).toEqual({ baseUrl: "http://localhost:8787", apiKey: "" });
  expect(load).not.toHaveBeenCalled();
});

test("getSettings honours env overrides when Tauri bridge absent", async () => {
  delete (window as any)[INTERNALS];
  vi.stubEnv("VITE_API_BASE", "http://192.168.0.9:9000");
  vi.stubEnv("VITE_API_KEY", "envkey");
  expect(await getSettings()).toEqual({ baseUrl: "http://192.168.0.9:9000", apiKey: "envkey" });
  expect(load).not.toHaveBeenCalled();
});

test("saveSettings throws (does not silently drop) when Tauri bridge absent", async () => {
  delete (window as any)[INTERNALS];
  await expect(saveSettings({ baseUrl: "http://x", apiKey: "k" })).rejects.toThrow();
  expect(load).not.toHaveBeenCalled();
});

test("getSettings uses the plugin store when Tauri bridge present", async () => {
  (window as any)[INTERNALS] = {};
  const store = {
    get: vi.fn(async (k: string) => (k === "baseUrl" ? "http://stored:1" : "storedkey")),
    set: vi.fn(),
    save: vi.fn(),
  };
  load.mockResolvedValue(store);
  expect(await getSettings()).toEqual({ baseUrl: "http://stored:1", apiKey: "storedkey" });
  expect(load).toHaveBeenCalledWith("settings.json", { autoSave: false, defaults: {} });
});

test("saveSettings writes through the plugin store when Tauri bridge present", async () => {
  (window as any)[INTERNALS] = {};
  const store = { get: vi.fn(), set: vi.fn(), save: vi.fn() };
  load.mockResolvedValue(store);
  await saveSettings({ baseUrl: "http://y", apiKey: "kk" });
  expect(store.set).toHaveBeenCalledWith("baseUrl", "http://y");
  expect(store.set).toHaveBeenCalledWith("apiKey", "kk");
  expect(store.save).toHaveBeenCalledTimes(1);
});
