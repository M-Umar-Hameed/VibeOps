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
