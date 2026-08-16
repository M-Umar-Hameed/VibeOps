import { beforeEach, expect, test } from "vitest";
import { bump, timing, snapshot, resetMetrics } from "../src/services/metrics.js";
import { app } from "../src/api/app.js";
import { createActor } from "../src/services/actors.js";
import { upsertSourceDoc } from "../src/services/knowledge.js";
import { FakeEmbedder } from "../src/knowledge/embedder.js";

beforeEach(() => resetMetrics());

test("bump accumulates", () => {
  bump("x");
  bump("x");
  expect(snapshot().counters.x).toBe(2);
});

test("bump respects n", () => {
  bump("y", 5);
  expect(snapshot().counters.y).toBe(5);
});

test("timing records count and totalMs", () => {
  timing("boot.z", 12);
  const t = snapshot().timings["boot.z"];
  expect(t.count).toBe(1);
  expect(t.totalMs).toBe(12);
});

test("snapshot is a copy, not live state", () => {
  bump("c");
  const s = snapshot();
  s.counters.c = 999;
  expect(snapshot().counters.c).toBe(1);
});

test("resetMetrics clears all", () => {
  bump("a"); timing("b", 1);
  resetMetrics();
  expect(snapshot()).toEqual({ counters: {}, timings: {} });
});

test("GET /system/metrics-lite 401s without a key", async () => {
  const res = await app.request("/system/metrics-lite");
  expect(res.status).toBe(401);
});

test("GET /system/metrics-lite returns snapshot for admin", async () => {
  const { apiKey } = await createActor({ name: "metrics-admin", kind: "human", role: "admin" });
  const res = await app.request("/system/metrics-lite", { headers: { Authorization: `Bearer ${apiKey}` } });
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data).toHaveProperty("counters");
  expect(data).toHaveProperty("timings");
  expect(data.counters["req.GET"]).toBeGreaterThanOrEqual(1);
});

test("upsertSourceDoc bumps embed.chunks by the number embedded", async () => {
  const emb = new FakeEmbedder(1024);
  const ref = `metrics-embed-${Date.now()}`;
  const before = snapshot().counters["embed.chunks"] ?? 0;
  const embedded = await upsertSourceDoc("session", ref, "small doc body for metrics test", emb);
  const after = snapshot().counters["embed.chunks"] ?? 0;
  expect(embedded).toBeGreaterThan(0);
  expect(after - before).toBe(embedded);
});
