import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { sweepSinceDays, sweepOnce } from "../src/ingest/sessions/auto-sync.js";
import { setSetting, getSetting, deleteSetting } from "../src/services/settings.js";
import { FakeEmbedder } from "../src/knowledge/embedder.js";
import type { SessionSource } from "../src/ingest/sessions/source.js";
import { listJobs, cancelJob } from "../src/services/jobs.js";

const emb = new FakeEmbedder(1024);

test("sweepSinceDays with various inputs", () => {
  const now = Date.parse("2026-11-11T00:00:00Z");

  expect(sweepSinceDays(new Date(now - 5 * 86_400_000).toISOString(), now)).toBe(6);
  expect(sweepSinceDays(null, now)).toBe(30);
  expect(sweepSinceDays("garbage", now)).toBe(30);
  expect(sweepSinceDays(new Date(now - 90 * 86_400_000).toISOString(), now)).toBe(30);
  expect(sweepSinceDays(new Date(now).toISOString(), now)).toBe(1);
});

test("sweepOnce uses stored value and advances it", async () => {
  const key = `sessions.lastSweepAt.test-${randomUUID()}`;
  const fiveDaysAgoIso = new Date(Date.now() - (5 * 86_400_000 - 60_000)).toISOString();
  await setSetting(key, fiveDaysAgoIso);

  let seenDays: number[] = [];
  const src: SessionSource = {
    source: "test",
    async listSessionDocs(sinceDays) {
      seenDays.push(sinceDays);
      return [];
    },
  };

  const before = Date.now();
  await sweepOnce([src], emb, key);

  expect(seenDays).toEqual([6]);
  const stored = await getSetting(key);
  expect(Date.parse(stored!)).toBeGreaterThanOrEqual(before);

  await deleteSetting(key);
});

test("sweepOnce with missing key uses 30", async () => {
  const key = `sessions.lastSweepAt.test-${randomUUID()}`;
  let seenDays: number[] = [];
  const src: SessionSource = {
    source: "test",
    async listSessionDocs(sinceDays) {
      seenDays.push(sinceDays);
      return [];
    },
  };

  await sweepOnce([src], emb, key);
  expect(seenDays).toEqual([30]);

  await deleteSetting(key);
});

test("cancelled sweep does not advance lastSweepAt", async () => {
  const key = `sessions.lastSweepAt.test-${randomUUID()}`;
  const fiveDaysAgoIso = new Date(Date.now() - (5 * 86_400_000 - 60_000)).toISOString();
  await setSetting(key, fiveDaysAgoIso);

  const src: SessionSource = {
    source: "test",
    async listSessionDocs() {
      const jobs = listJobs({ kind: "sessions", active: true });
      if (jobs.length > 0) cancelJob(jobs[0].id);
      return [];
    },
  };

  await sweepOnce([src], emb, key);
  expect(await getSetting(key)).toBe(fiveDaysAgoIso);

  await deleteSetting(key);
});
