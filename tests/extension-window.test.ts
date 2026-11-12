import { describe, it, expect, vi } from "vitest";
import {
  withPaintableWindow,
  wantsPaint,
  needsDebugger,
  keepPageLive,
  captureScreenshotVia,
  MAX_SCREENSHOT_B64,
} from "../extension/window.js";

describe("withPaintableWindow", () => {
  it("restores minimized window with focused:false before run and re-minimizes after", async () => {
    const windows = {
      get: vi.fn().mockResolvedValue({ id: 10, state: "minimized" }),
      update: vi.fn().mockResolvedValue({}),
    };
    const runOrder: string[] = [];
    windows.update.mockImplementation(async (_id: number, opts: { state: string; focused?: boolean }) => {
      runOrder.push(`update:${opts.state}`);
      return {};
    });

    const res = await withPaintableWindow(windows, 10, true, async () => {
      runOrder.push("run");
      return "result-val";
    });

    expect(res).toBe("result-val");
    expect(windows.get).toHaveBeenCalledWith(10);
    expect(windows.update).toHaveBeenNthCalledWith(1, 10, { state: "normal", focused: false });
    expect(windows.update).toHaveBeenNthCalledWith(2, 10, { state: "minimized" });
    expect(runOrder).toEqual(["update:normal", "run", "update:minimized"]);
  });

  it("does not update when window state is normal, maximized, or fullscreen", async () => {
    for (const state of ["normal", "maximized", "fullscreen"]) {
      const windows = {
        get: vi.fn().mockResolvedValue({ id: 10, state }),
        update: vi.fn().mockResolvedValue({}),
      };
      const res = await withPaintableWindow(windows, 10, true, async () => "ok");
      expect(res).toBe("ok");
      expect(windows.update).not.toHaveBeenCalled();
    }
  });

  it("does not get or update when wanted is false", async () => {
    const windows = {
      get: vi.fn(),
      update: vi.fn(),
    };
    const res = await withPaintableWindow(windows, 10, false, async () => "ok");
    expect(res).toBe("ok");
    expect(windows.get).not.toHaveBeenCalled();
    expect(windows.update).not.toHaveBeenCalled();
  });

  it("re-minimizes window when run throws and rethrows error", async () => {
    const windows = {
      get: vi.fn().mockResolvedValue({ id: 10, state: "minimized" }),
      update: vi.fn().mockResolvedValue({}),
    };
    await expect(
      withPaintableWindow(windows, 10, true, async () => {
        throw new Error("batch-fail");
      })
    ).rejects.toThrow("batch-fail");

    expect(windows.update).toHaveBeenNthCalledWith(1, 10, { state: "normal", focused: false });
    expect(windows.update).toHaveBeenNthCalledWith(2, 10, { state: "minimized" });
  });

  it("runs without update when windows.get rejects", async () => {
    const windows = {
      get: vi.fn().mockRejectedValue(new Error("window gone")),
      update: vi.fn().mockResolvedValue({}),
    };
    const res = await withPaintableWindow(windows, 10, true, async () => "ok");
    expect(res).toBe("ok");
    expect(windows.update).not.toHaveBeenCalled();
  });

  it("returns result even if re-minimize update rejects", async () => {
    const windows = {
      get: vi.fn().mockResolvedValue({ id: 10, state: "minimized" }),
      update: vi.fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error("window closed mid-batch")),
    };
    const res = await withPaintableWindow(windows, 10, true, async () => "ok");
    expect(res).toBe("ok");
    expect(windows.update).toHaveBeenCalledTimes(2);
  });

  it("never sets focused: true across any update calls", async () => {
    const windows = {
      get: vi.fn().mockResolvedValue({ id: 10, state: "minimized" }),
      update: vi.fn().mockResolvedValue({}),
    };
    await withPaintableWindow(windows, 10, true, async () => "ok");
    for (const call of windows.update.mock.calls) {
      expect((call[1] as any)?.focused).not.toBe(true);
    }
  });
});

describe("wantsPaint", () => {
  it("returns true for act grant, true for screenshot step, false for snapshot only", () => {
    expect(wantsPaint({ grant: "act", steps: [] })).toBe(true);
    expect(wantsPaint({ grant: "read", steps: [{ verb: "screenshot" }] })).toBe(true);
    expect(wantsPaint({ grant: "read", steps: [{ verb: "snapshot" }] })).toBe(false);
  });
});

describe("needsDebugger", () => {
  it("returns true for screenshot step, true for act + click, false for act + snapshot, false for null grant + click", () => {
    expect(needsDebugger(null, [{ verb: "screenshot" }])).toBe(true);
    expect(needsDebugger("act", [{ verb: "click" }])).toBe(true);
    expect(needsDebugger("act", [{ verb: "snapshot" }])).toBe(false);
    expect(needsDebugger(null, [{ verb: "click" }])).toBe(false);
  });
});

describe("captureScreenshotVia", () => {
  it("captures via CDP when cdpReady is true without calling captureVisibleTab", async () => {
    const send = vi.fn().mockResolvedValue({ data: "AAA" });
    const captureVisibleTab = vi.fn();

    const res = await captureScreenshotVia({ cdpReady: true, send, captureVisibleTab });

    expect(send).toHaveBeenCalledWith("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true, value: "AAA", path: "cdp" });
  });

  it("returns screenshot_failed on cdp path when send rejects without fallback", async () => {
    const send = vi.fn().mockRejectedValue(new Error("CDP error"));
    const captureVisibleTab = vi.fn();

    const res = await captureScreenshotVia({ cdpReady: true, send, captureVisibleTab });

    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(res).toEqual({
      ok: false,
      error: "screenshot failed: Error: CDP error",
      code: "screenshot_failed",
      path: "cdp",
    });
  });

  it("captures via captureVisibleTab when cdpReady is false", async () => {
    const captureVisibleTab = vi.fn().mockResolvedValue("data:image/png;base64,BBB");

    const res = await captureScreenshotVia({ cdpReady: false, send: vi.fn(), captureVisibleTab });

    expect(res).toEqual({ ok: true, value: "BBB", path: "visible" });
  });

  it("handles readback failure on captureVisibleTab with not visible message", async () => {
    const captureVisibleTab = vi.fn().mockRejectedValue(new Error("Failed to capture tab: image readback failed"));

    const res = await captureScreenshotVia({ cdpReady: false, send: vi.fn(), captureVisibleTab });

    expect(res.ok).toBe(false);
    expect(res.code).toBe("screenshot_failed");
    expect(res.path).toBe("visible");
    expect(res.error).toContain("not visible");
  });

  it("returns screenshot_failed with too large error when data exceeds MAX_SCREENSHOT_B64 on both paths", async () => {
    const oversized = "A".repeat(MAX_SCREENSHOT_B64 + 1);

    const cdpRes = await captureScreenshotVia({
      cdpReady: true,
      send: vi.fn().mockResolvedValue({ data: oversized }),
      captureVisibleTab: vi.fn(),
    });
    expect(cdpRes.ok).toBe(false);
    expect(cdpRes.code).toBe("screenshot_failed");
    expect(cdpRes.path).toBe("cdp");
    expect(cdpRes.error).toContain("too large");

    const visibleRes = await captureScreenshotVia({
      cdpReady: false,
      send: vi.fn(),
      captureVisibleTab: vi.fn().mockResolvedValue(`data:image/png;base64,${oversized}`),
    });
    expect(visibleRes.ok).toBe(false);
    expect(visibleRes.code).toBe("screenshot_failed");
    expect(visibleRes.path).toBe("visible");
    expect(visibleRes.error).toContain("too large");
  });
});

describe("keepPageLive", () => {
  it("sends Emulation.setFocusEmulationEnabled and Page.setWebLifecycleState, resolving even when both reject", async () => {
    const send = vi.fn().mockRejectedValue(new Error("unsupported"));

    await expect(keepPageLive(send)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", { enabled: true });
    expect(send).toHaveBeenCalledWith("Page.setWebLifecycleState", { state: "active" });
  });
});
