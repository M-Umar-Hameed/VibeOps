import { describe, it, expect, vi, beforeEach } from "vitest";

const submitBatch = vi.fn();
const hasActGrant = vi.fn();

vi.mock("../src/browser/channel.js", () => ({
  exists: vi.fn(() => true),
  list: vi.fn(() => []),
  submitBatch: (...a: any[]) => submitBatch(...a),
}));
vi.mock("../src/browser/grants.js", () => ({
  hasActGrant: (...a: any[]) => hasActGrant(...a),
  noActGrantReason: (o: string) => `no act grant for ${o}`,
}));

import { buildChatTools, type ToolCall } from "../src/chat/tools.js";

const actor = { id: "a1", name: "t", kind: "human", role: "admin" } as any;
const getAct = (calls: ToolCall[]) =>
  buildChatTools(actor, calls).find((t: any) => t.name === "browser_act") as any;

beforeEach(() => { submitBatch.mockReset(); hasActGrant.mockReset(); });

describe("browser_act", () => {
  it("surfaces the no-grant reason verbatim in text and the tool-call summary; does not enqueue", async () => {
    hasActGrant.mockResolvedValue(false);
    const calls: ToolCall[] = [];
    const res = await getAct(calls).handler(
      { instanceId: "i1", targetOrigin: "https://github.com", steps: [{ verb: "click", ref: "ref1" }] }, {},
    );
    expect(res.content[0].text).toContain("no act grant for https://github.com");
    expect(calls.some((c) => c.summary.includes("refused"))).toBe(true);
    expect(submitBatch).not.toHaveBeenCalled();
  });

  it("records the server-refused origin as grantOrigin, verbatim (Allow affordance source)", async () => {
    hasActGrant.mockResolvedValue(false);
    const calls: ToolCall[] = [];
    await getAct(calls).handler(
      { instanceId: "i1", targetOrigin: "https://github.com", steps: [{ verb: "click", ref: "ref1" }] }, {},
    );
    const refusal = calls.find((c) => c.summary.includes("refused"))!;
    // Comes from the origin the server checked, not from any model-authored text.
    expect(refusal.grantOrigin).toBe("https://github.com");
  });

  it("with a grant, enqueues with grant:act+targetOrigin and returns the snapshot", async () => {
    hasActGrant.mockResolvedValue(true);
    submitBatch.mockResolvedValue({ results: [{ ok: true }], snapshot: { origin: "https://github.com", nodes: [] } });
    const calls: ToolCall[] = [];
    const res = await getAct(calls).handler(
      { instanceId: "i1", targetOrigin: "https://github.com", steps: [{ verb: "click", ref: "ref1" }] }, {},
    );
    expect(submitBatch).toHaveBeenCalledWith("i1", "i1", [{ verb: "click", ref: "ref1" }], { grant: "act", targetOrigin: "https://github.com" });
    expect(res.content[0].text).toContain("github.com");
    expect(calls.some((c) => c.summary === "ok")).toBe(true);
  });

  it("surfaces an extension refusal (e.g. origin mismatch) verbatim", async () => {
    hasActGrant.mockResolvedValue(true);
    submitBatch.mockResolvedValue({ results: [{ ok: false, error: "origin mismatch: page https://evil.com != granted https://github.com" }], snapshot: {} });
    const calls: ToolCall[] = [];
    const res = await getAct(calls).handler(
      { instanceId: "i1", targetOrigin: "https://github.com", steps: [{ verb: "click", ref: "ref1" }] }, {},
    );
    expect(res.content[0].text).toContain("origin mismatch");
    expect(calls.some((c) => c.summary.includes("refused"))).toBe(true);
  });
});
