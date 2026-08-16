import { expect, test, vi } from "vitest";
import { startSessionAutoSync } from "../src/ingest/sessions/auto-sync.js";
import { setSetting, deleteSetting } from "../src/services/settings.js";
import { searchKnowledge } from "../src/services/knowledge.js";
import { FakeEmbedder } from "../src/knowledge/embedder.js";
import type { SessionSource } from "../src/ingest/sessions/source.js";

const emb = new FakeEmbedder(1024);

test("auto-sync indexes a fresh transcript within one interval, no UI action", async () => {
  await deleteSetting("sessions.autoSync"); // enabled by default
  const uniq = `autosync-${Date.now()}`;
  const doc = { ref: `fake#${uniq}`, text: `auto content ${uniq}`, hash: `h-${uniq}` };
  const src: SessionSource = { source: "fake", listSessionDocs: async () => [doc] };
  const handle = await startSessionAutoSync({ intervalMs: 10, sources: [src], embedder: emb });
  expect(handle).not.toBeNull();
  try {
    await vi.waitFor(async () => {
      const hits = await searchKnowledge(doc.text, { limit: 20 }, emb);
      expect(hits.some((h) => h.sourceRef === doc.ref && h.sourceKind === "session")).toBe(true);
    }, { timeout: 2000, interval: 20 });
  } finally {
    handle!.stop();
  }
});

test("off switch stops the timer (no sweep runs)", async () => {
  await setSetting("sessions.autoSync", "false");
  let calls = 0;
  const src: SessionSource = { source: "fake", listSessionDocs: async () => { calls++; return []; } };
  try {
    const handle = await startSessionAutoSync({ intervalMs: 10, sources: [src], embedder: emb });
    expect(handle).toBeNull();
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toBe(0);
  } finally {
    await deleteSetting("sessions.autoSync");
  }
});
