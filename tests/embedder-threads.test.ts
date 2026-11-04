import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveEmbedThreads, resetLocalPipeline } from "../src/knowledge/embedder.js";
import { withSetting } from "./helpers/settings.js";

describe("embedder-threads.test.ts", () => {
  it("resolveEmbedThreads", () => {
    expect(resolveEmbedThreads(null)).toBe(6);
    expect(resolveEmbedThreads("3")).toBe(3);
    expect(resolveEmbedThreads("12")).toBe(6);
    expect(resolveEmbedThreads("0")).toBe(1);
    expect(resolveEmbedThreads("x")).toBe(6);
  });

  it("LocalEmbedder uses threads from setting", async () => {
    const transformers = await import("@huggingface/transformers");
    const mockPipeline = vi.fn().mockResolvedValue({
      tolist: vi.fn().mockReturnValue([[0.1, 0.2, 0.3]]),
    });
    vi.spyOn(transformers, "pipeline").mockImplementation(mockPipeline as any);

    await withSetting("knowledge.embedThreads", "3", async () => {
      resetLocalPipeline();
      const { LocalEmbedder } = await import("../src/knowledge/embedder.js");
      const emb = new LocalEmbedder();
      await emb.embed(["test"]);

      expect(mockPipeline).toHaveBeenCalled();
      const call = mockPipeline.mock.calls[0];
      expect(call[2]).toMatchObject({
        session_options: { intraOpNumThreads: 3, interOpNumThreads: 1 },
      });
    });

    vi.restoreAllMocks();
  });

  it("LocalEmbedder batches 70 texts into 32/32/6", async () => {
    const transformers = await import("@huggingface/transformers");
    const batches: number[] = [];
    const mockPipe = vi.fn((texts: string[]) => {
      batches.push(texts.length);
      return Promise.resolve({
        tolist: vi.fn(() => texts.map(() => new Array(384).fill(0.1))),
      });
    });
    vi.spyOn(transformers, "pipeline").mockResolvedValue(mockPipe as any);

    resetLocalPipeline();
    const { LocalEmbedder } = await import("../src/knowledge/embedder.js");
    const emb = new LocalEmbedder();
    const result = await emb.embed(Array.from({ length: 70 }, (_, i) => `text${i}`));

    expect(batches).toEqual([32, 32, 6]);
    expect(result.length).toBe(70);
    expect(result[0].length).toBe(1024); // padded

    vi.restoreAllMocks();
  });
});
