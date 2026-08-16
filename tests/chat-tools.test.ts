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

// The extension was linked and the agent still said it could not connect: the
// tools demanded an instanceId the model cannot discover. Omitting it must
// target the single live instance.
import { list as listMock } from "../src/browser/channel.js";

describe("chat browser tools: instance auto-targeting", () => {
  it("omitted instanceId targets the single connected instance", async () => {
    (listMock as any).mockReturnValue([{ instanceId: "solo-1", browserChannel: "chrome", profileId: "p", profileLabel: "Work", connectedAt: "" }]);
    const calls: ToolCall[] = [];
    const tools = buildChatTools({ id: "a1", name: "t", kind: "human", role: "admin" } as any, calls);
    const snap = tools.find((t: any) => t.name === "browser_snapshot") as any;
    const res = await snap.handler({}, {});
    expect(res.content[0].text).toContain("verb not enabled until grants land");
    expect(calls.some((c) => c.summary === "refused: verb not enabled until grants land")).toBe(true);
  });

  it("no instances explains how to connect", async () => {
    (listMock as any).mockReturnValue([]);
    const calls: ToolCall[] = [];
    const tools = buildChatTools({ id: "a1", name: "t", kind: "human", role: "admin" } as any, calls);
    const snap = tools.find((t: any) => t.name === "browser_snapshot") as any;
    const res = await snap.handler({}, {});
    expect(res.content[0].text).toContain("press Connect");
  });
});
