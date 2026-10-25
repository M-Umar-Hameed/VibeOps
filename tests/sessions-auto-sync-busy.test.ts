import { expect, test, vi } from "vitest";
import { startSessionAutoSync } from "../src/ingest/sessions/auto-sync.js";
import { deleteSetting } from "../src/services/settings.js";
import { FakeEmbedder } from "../src/knowledge/embedder.js";
import type { SessionSource } from "../src/ingest/sessions/source.js";

const emb = new FakeEmbedder(1024);

function counting() {
  const s = { calls: 0 };
  const src: SessionSource = { source: "fake", listSessionDocs: async () => { s.calls++; return []; } };
  return { s, src };
}

test("runNow skips the sweep while a Forge run is active", async () => {
  await deleteSetting("sessions.autoSync");
  const { s, src } = counting();
  const handle = await startSessionAutoSync({ runNow: true, intervalMs: 60_000, sources: [src], embedder: emb, isBusy: () => true });
  expect(handle).not.toBeNull();
  try {
    await new Promise((r) => setTimeout(r, 100));
    expect(s.calls).toBe(0);
  } finally {
    handle!.stop();
  }
});

test("runNow sweeps when no Forge run is active", async () => {
  await deleteSetting("sessions.autoSync");
  const { s, src } = counting();
  const handle = await startSessionAutoSync({ runNow: true, intervalMs: 60_000, sources: [src], embedder: emb, isBusy: () => false });
  try {
    await vi.waitFor(() => expect(s.calls).toBeGreaterThan(0), { timeout: 2000, interval: 20 });
  } finally {
    handle!.stop();
  }
});
