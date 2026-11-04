import { describe, it, expect } from "vitest";
import { LocalEmbedder, resetLocalPipeline } from "../src/knowledge/embedder.js";
import { withSetting } from "./helpers/settings.js";

describe.skipIf(!process.env.LOCAL_EMBED_TEST)("embedder-throughput.test.ts", () => {
  it("throughput: threads 1 vs threads 6, batch 1 vs batch 32", async () => {
    const chunks = Array.from({ length: 256 }, (_, i) => "A".repeat(1000) + ` ${i}`);

    let throughputA = 0;
    // Run A: threads 1, one text per call
    await withSetting("knowledge.embedThreads", "1", async () => {
      resetLocalPipeline();
      const emb = new LocalEmbedder();
      const start = performance.now();
      for (const chunk of chunks) {
        await emb.embed([chunk]);
      }
      const elapsed = (performance.now() - start) / 1000;
      throughputA = chunks.length / elapsed;
      console.log(`Run A (1 thread, 1 per call): ${throughputA.toFixed(1)} chunks/s`);
    });

    // Run B: threads 6, 32 per call
    await withSetting("knowledge.embedThreads", "6", async () => {
      resetLocalPipeline();
      const emb = new LocalEmbedder();
      const start = performance.now();
      await emb.embed(chunks);
      const elapsed = (performance.now() - start) / 1000;
      const throughputB = chunks.length / elapsed;
      console.log(`Run B (6 threads, 32 per call): ${throughputB.toFixed(1)} chunks/s`);
      expect(throughputB).toBeGreaterThanOrEqual(throughputA);
    });
  });
});
