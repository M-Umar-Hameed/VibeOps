import { describe, it, expect, vi } from "vitest";

// The transcript's toolCalls row AND the text handed back to the model must
// both carry a browser refusal - a mutant that records "refused" but tells
// the model "ok" makes the agent hallucinate success.
vi.mock("../src/browser/channel.js", () => ({
  exists: vi.fn(() => true),
  list: vi.fn(() => []),
  submitBatch: vi.fn(async () => ({
    results: [{ ok: false, error: "verb not enabled until grants land" }],
    snapshot: { instanceId: "i1", origin: "", identity: null, nodes: [] },
  })),
}));

import { buildChatTools, type ToolCall } from "../src/chat/tools.js";

describe("chat browser tools", () => {
  it("a refusal reaches both the tool-call summary and the model-facing text", async () => {
    const calls: ToolCall[] = [];
    const tools = buildChatTools({ id: "a1", name: "t", kind: "human", role: "admin" } as any, calls);
    const snap = tools.find((t: any) => t.name === "browser_snapshot") as any;
    const res = await snap.handler({ instanceId: "i1" }, {});
    const text = res.content[0].text as string;
    expect(text).toContain("verb not enabled until grants land");
    expect(calls.some((c) => c.summary.includes("refused"))).toBe(true);
  });
});
