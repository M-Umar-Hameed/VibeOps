import { expect, test, vi } from "vitest";
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

test("admin shutdown acks 200 and fires the handler on the next tick", async () => {
  vi.useFakeTimers();
  const handler = vi.fn(async () => {});
  setShutdownHandler(handler);
  const res = await app.request("/system/shutdown", { method: "POST", headers: await headers("admin") });
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
