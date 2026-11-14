import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("agentTab throwing reports the error via /browser/results", async () => {
  const chromeStub = {
    action: {
      onClicked: { addListener: vi.fn() },
    },
    runtime: {
      openOptionsPage: vi.fn(),
      onMessage: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
    },
    debugger: { onDetach: { addListener: vi.fn() } },
    alarms: {
      create: vi.fn(),
      onAlarm: { addListener: vi.fn() },
    },
    storage: {
      local: {
        get: vi.fn(async () => ({ apiKey: "k", profileId: "p" })),
        set: vi.fn(async () => {}),
      },
      session: {
        get: vi.fn(async () => {
          throw new Error("session boom");
        }),
        set: vi.fn(async () => {}),
      },
    },
  };
  vi.stubGlobal("chrome", chromeStub);

  let resultsPayload: any = null;
  let pollCount = 0;

  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("/browser/instances/register")) {
      return {
        ok: true,
        status: 201,
        json: async () => ({ instanceId: "i1" }),
      };
    }
    if (urlStr.includes("/browser/poll")) {
      pollCount++;
      if (pollCount === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            batchId: "b1",
            steps: [{ verb: "snapshot" }],
          }),
        };
      }
      return new Promise(() => {});
    }
    if (urlStr.includes("/browser/results")) {
      if (init?.body) {
        resultsPayload = JSON.parse(init.body as string);
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
      };
    }
    throw new Error(`Unexpected fetch call to ${urlStr}`);
  }));

  vi.spyOn(console, "error").mockImplementation(() => {});

  await import("../extension/worker.js");

  await vi.waitFor(() => {
    expect(resultsPayload).not.toBeNull();
  });

  expect(resultsPayload).toEqual({
    batchId: "b1",
    result: {
      results: [{ ok: false, error: "Error: session boom" }],
      snapshot: { instanceId: "i1", origin: "", identity: null, nodes: [] },
    },
  });
});

function actStub(execScript: (opts: any) => Promise<any>) {
  return {
    action: { onClicked: { addListener: vi.fn() } },
    runtime: { openOptionsPage: vi.fn(), onMessage: { addListener: vi.fn() }, onInstalled: { addListener: vi.fn() }, getURL: (p: string) => p },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
    storage: {
      local: { get: vi.fn(async () => ({ apiKey: "k", profileId: "p" })), set: vi.fn(async () => {}) },
      session: { get: vi.fn(async () => ({ agentWindowId: 1, agentTabId: 2 })), set: vi.fn(async () => {}) },
    },
    windows: { get: vi.fn(async () => ({ id: 1, state: "normal" })), update: vi.fn(async () => ({})) },
    tabs: { get: vi.fn(async () => ({ id: 2, windowId: 1, url: "http://x/" })) },
    debugger: {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async () => ({})),
      onDetach: { addListener: vi.fn() },
    },
    scripting: { executeScript: execScript },
  };
}

async function runBatches(batches: any[]) {
  vi.resetModules();
  const calls: any[] = [];
  const execScript = vi.fn(async (opts: any) => {
    calls.push(opts);
    const timed = opts.args[5] ? { pageMs: { import: 1, execute: 2 } } : {};
    return opts.args[0].length
      ? [{ result: { results: [{ ok: true, cdp: { verb: "click", x: 10, y: 20 } }], snapshot: null, ...timed } }]
      : [{ result: { results: [], snapshot: { origin: "http://x", identity: null, nodes: [] }, ...timed } }];
  });
  vi.stubGlobal("chrome", actStub(execScript));
  const queue = [...batches];
  const payloads: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/browser/instances/register")) return { ok: true, status: 201, json: async () => ({ instanceId: "i1" }) };
    if (u.includes("/browser/poll")) {
      const b = queue.shift();
      return b ? { ok: true, status: 200, json: async () => b } : new Promise(() => {});
    }
    if (u.includes("/browser/results")) {
      payloads.push(JSON.parse(init!.body as string));
      return { ok: true, status: 200, json: async () => ({}) };
    }
    throw new Error(`Unexpected fetch call to ${u}`);
  }));
  await import("../extension/worker.js");
  await vi.waitFor(() => expect(payloads.length).toBe(batches.length));
  return { payloads, calls };
}

const clickBatch = (extra: object = {}, batchId = "b1") => ({
  batchId,
  steps: [{ verb: "click", ref: "e1" }],
  grant: "act",
  targetOrigin: "http://x",
  ...extra,
});

test("untimed act batch result is byte-identical and page args unchanged", async () => {
  const { payloads, calls } = await runBatches([clickBatch()]);
  expect(JSON.stringify(payloads[0])).toBe(
    '{"batchId":"b1","result":{"results":[{"ok":true,"path":"cdp"}],"snapshot":{"origin":"http://x","identity":null,"nodes":[],"instanceId":"i1"}}}',
  );
  for (const c of calls) expect(c.args.length).toBe(5);
});

test("timed act batch adds timings only", async () => {
  const { payloads } = await runBatches([clickBatch({ timings: true })]);
  const { results, snapshot, timings } = payloads[0].result;
  expect(results).toEqual([{ ok: true, path: "cdp" }]);
  expect(snapshot).toEqual({ origin: "http://x", identity: null, nodes: [], instanceId: "i1" });
  for (const k of [
    "agentTab", "window.get", "lease", "executeScript", "page.import", "page.execute", "dispatchCdp",
    "cdp.Input.dispatchMouseEvent.mouseMoved", "cdp.Input.dispatchMouseEvent.mousePressed", "cdp.Input.dispatchMouseEvent.mouseReleased",
    "snapshotScript", "snapshotPage.import", "snapshotPage.execute", "total",
  ]) {
    expect(typeof timings[k]).toBe("number");
    expect(timings[k]).toBeGreaterThanOrEqual(0);
  }
  expect(JSON.stringify(payloads[0])).not.toContain("pageMs");
  expect(timings).not.toHaveProperty("prev");
});

test("next timed batch carries prev", async () => {
  const { payloads } = await runBatches([clickBatch({ timings: true }), clickBatch({ timings: true }, "b2")]);
  expect(typeof payloads[1].result.timings.prev.submit).toBe("number");
  expect(payloads[1].result.timings.prev["window.minimize"]).toBe(0);
});
