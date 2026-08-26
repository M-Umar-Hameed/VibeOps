import { describe, it, expect, vi, beforeEach } from "vitest";

const submitBatch = vi.fn();
const hasActGrant = vi.fn();

vi.mock("../src/browser/channel.js", () => ({
  exists: vi.fn(() => true),
  list: vi.fn(() => [{ instanceId: "i1", profileLabel: "p", browserChannel: "c", profileId: "pid", connectedAt: "" }]),
  submitBatch: (...a: any[]) => submitBatch(...a),
}));
// Partial-mock: real noActGrantReason so the refusal text is the SAME string the
// chat path (src/chat/tools.ts) emits — proving one grant model, one message.
vi.mock("../src/browser/grants.js", async (orig) => ({
  ...(await (orig() as Promise<object>)),
  hasActGrant: (...a: any[]) => hasActGrant(...a),
}));

import { createActor } from "../src/services/actors.js";
import { buildServer } from "../src/mcp/server.js";
import { noActGrantReason } from "../src/browser/grants.js";
import { drainBrowserCalls } from "../src/browser/pending-grants.js";
import { buildChatTools, type ToolCall } from "../src/chat/tools.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

async function connectedClient() {
  const { actor, apiKey } = await createActor({ name: `mcpbrowser-${Math.random()}`, kind: "agent" });
  const server = await buildServer(apiKey);
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0.0.0" });
  await Promise.all([server.connect(s), client.connect(c)]);
  return { client, actor };
}

beforeEach(() => { submitBatch.mockReset(); hasActGrant.mockReset(); });

describe("MCP browser verbs", () => {
  it("lists browser_snapshot, browser_read, browser_act", async () => {
    const { client } = await connectedClient();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["browser_snapshot", "browser_read", "browser_act"]));
    await client.close();
  });

  it("REFUSES a mutating batch without an act grant, with the chat path's refusal text", async () => {
    hasActGrant.mockResolvedValue(false);
    const { client } = await connectedClient();
    const res: any = await client.callTool({
      name: "browser_act",
      arguments: { instanceId: "i1", targetOrigin: "https://github.com", steps: [{ verb: "click", ref: "ref1" }] },
    });
    const text = res.content[0].text;
    expect(text).toContain(noActGrantReason("https://github.com"));
    expect(submitBatch).not.toHaveBeenCalled();

    // Same origin, same absent grant, through the chat SDK path -> identical refusal.
    hasActGrant.mockResolvedValue(false);
    const calls: ToolCall[] = [];
    const act = buildChatTools({ id: "a1", name: "t", kind: "human", role: "admin" } as any, calls).find((t: any) => t.name === "browser_act") as any;
    const chatRes = await act.handler({ instanceId: "i1", targetOrigin: "https://github.com", steps: [{ verb: "click", ref: "ref1" }] }, {});
    expect(chatRes.content[0].text).toBe(text);
    await client.close();
  });

  it("records the refusal in the pending-grants ledger for the CLI lane to drain", async () => {
    hasActGrant.mockResolvedValue(false);
    const { client, actor } = await connectedClient();
    await client.callTool({
      name: "browser_act",
      arguments: { instanceId: "i1", targetOrigin: "https://github.com", steps: [{ verb: "click", ref: "ref1" }] },
    });
    const drained = drainBrowserCalls({ actorId: actor.id, since: 0 });
    expect(drained).toHaveLength(1);
    expect(drained[0].name).toBe("browser_act");
    expect(drained[0].grantOrigin).toBe("https://github.com");
    expect(drained[0].summary).toBe(`refused: ${noActGrantReason("https://github.com")}`);
    await client.close();
  });

  it("records a successful snapshot and a refused act in call order", async () => {
    hasActGrant.mockResolvedValue(false);
    submitBatch.mockResolvedValue({ results: [{ ok: true }], snapshot: { origin: "https://github.com", nodes: [] } });
    const { client, actor } = await connectedClient();
    await client.callTool({ name: "browser_snapshot", arguments: { instanceId: "i1" } });
    await client.callTool({
      name: "browser_act",
      arguments: { instanceId: "i1", targetOrigin: "https://github.com", steps: [{ verb: "click", ref: "ref1" }] },
    });
    const drained = drainBrowserCalls({ actorId: actor.id, since: 0 });
    expect(drained.map((c) => ({ name: c.name, summary: c.summary }))).toEqual([
      { name: "browser_snapshot", summary: "ok" },
      { name: "browser_act", summary: `refused: ${noActGrantReason("https://github.com")}` },
    ]);
    await client.close();
  });

  it("with an act grant, the SAME MCP call enqueues grant:act+targetOrigin and returns the snapshot", async () => {
    hasActGrant.mockResolvedValue(true);
    submitBatch.mockResolvedValue({ results: [{ ok: true }], snapshot: { origin: "https://github.com", nodes: [] } });
    const { client } = await connectedClient();
    const res: any = await client.callTool({
      name: "browser_act",
      arguments: { instanceId: "i1", targetOrigin: "https://github.com", steps: [{ verb: "click", ref: "ref1" }] },
    });
    expect(submitBatch).toHaveBeenCalledWith("i1", "i1", [{ verb: "click", ref: "ref1" }], { grant: "act", targetOrigin: "https://github.com" });
    expect(res.content[0].text).toContain("github.com");
    await client.close();
  });
});
