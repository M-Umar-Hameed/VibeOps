import { afterEach, expect, test, vi } from "vitest";
import { createActor } from "../src/services/actors.js";
import { app } from "../src/api/app.js";
import { setShutdownHandler } from "../src/api/shutdown.js";

async function headers(role: "admin" | "member"): Promise<Record<string, string>> {
  const { apiKey } = await createActor({
    name: `sd-${role}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    kind: "human", role,
  });
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

// A test that fails while timers are faked never reaches its own restore, and
// every later test in the file then hangs on its first query. Restore here so
// one failure stays one failure.
afterEach(() => { vi.useRealTimers(); });

test("admin shutdown acks 200 and fires the handler on the next tick", async () => {
  // Database work must stay on real timers: postgres.js defers writes under
  // 1024 bytes through setImmediate, which fake timers freeze, so the query
  // never reaches the server. Create the actor and warm the auth cache first
  // (metrics-lite is admin-only and reads memory), leaving the request under
  // fake timers with no database round-trip of its own.
  const h = await headers("admin");
  expect((await app.request("/system/metrics-lite", { headers: h })).status).toBe(200);

  const handler = vi.fn(async () => {});
  setShutdownHandler(handler);
  vi.useFakeTimers();
  const res = await app.request("/system/shutdown", { method: "POST", headers: h });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(handler).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(50);
  expect(handler).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});

test("member is forbidden and the handler never fires", async () => {
  const handler = vi.fn(async () => {});
  setShutdownHandler(handler);
  const res = await app.request("/system/shutdown", { method: "POST", headers: await headers("member") });
  expect(res.status).toBe(403);
  expect(handler).not.toHaveBeenCalled();
});

test("503 when no server is wired", async () => {
  setShutdownHandler(undefined);
  const res = await app.request("/system/shutdown", { method: "POST", headers: await headers("admin") });
  expect(res.status).toBe(503);
});
