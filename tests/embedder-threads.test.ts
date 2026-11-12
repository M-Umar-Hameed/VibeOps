import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveEmbedThreads, resetLocalPipeline, LocalEmbedder } from "../src/knowledge/embedder.js";
import { withSetting } from "./helpers/settings.js";

const mockPipeline = vi.fn();

vi.mock("@huggingface/transformers", () => ({
  env: {},
  pipeline: (...args: any[]) => mockPipeline(...args),
}));

describe("embedder-threads.test.ts", () => {
  beforeEach(() => {
    mockPipeline.mockReset();
    resetLocalPipeline();
  });

  it("resolveEmbedThreads", () => {
    expect(resolveEmbedThreads(null)).toBe(6);
    expect(resolveEmbedThreads("3")).toBe(3);
    expect(resolveEmbedThreads("12")).toBe(6);
    expect(resolveEmbedThreads("0")).toBe(1);
    expect(resolveEmbedThreads("x")).toBe(6);
  });

  it("LocalEmbedder uses threads from setting", async () => {
    mockPipeline.mockImplementation(async (_task: string, _model: string, _options: any) => {
      return async (texts: string[]) => ({
        tolist: () => texts.map(() => new Array(384).fill(0.1)),
      });
    });

    await withSetting("knowledge.embedThreads", "3", async () => {
      resetLocalPipeline();
      const emb = new LocalEmbedder();
      await emb.embed(["test"]);

      expect(mockPipeline).toHaveBeenCalled();
      const call = mockPipeline.mock.calls[0];
      expect(call[2]).toMatchObject({
        session_options: { intraOpNumThreads: 3, interOpNumThreads: 1 },
      });
    });
  });

  it("LocalEmbedder batches 70 texts into 32/32/6", async () => {
    const batches: number[] = [];
    mockPipeline.mockImplementation(async () => {
      return async (texts: string[]) => {
        batches.push(texts.length);
        return {
          tolist: () => texts.map(() => new Array(384).fill(0.1)),
        };
      };
    });

    resetLocalPipeline();
    const emb = new LocalEmbedder();
    const result = await emb.embed(Array.from({ length: 70 }, (_, i) => `text${i}`));

    expect(batches).toEqual([32, 32, 6]);
    expect(result.length).toBe(70);
    expect(result[0].length).toBe(1024); // padded
  });
});
