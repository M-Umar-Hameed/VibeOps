import { describe, it, expect, vi, beforeEach } from "vitest";

const runAgentMock = vi.fn();
const getSessionMock = vi.fn();
const getMessagesMock = vi.fn();
const appendMessageMock = vi.fn();

vi.mock("../src/relay/invoke.js", () => ({
  runAgent: (...args: any[]) => runAgentMock(...args),
  substituteCmd: (cmd: string[]) => cmd,
}));

vi.mock("../src/relay/config.js", () => ({
  loadRelayConfig: () => ({
    workdir: "/test-workdir",
    agents: {
      "claude-cli": { cmd: ["claude", "-p", "{promptFile}"], roles: ["work"], mcp: true },
      agy: { cmd: ["agy", "{model}"], roles: ["plan", "work"] },
    },
  }),
  resolveCmd: (agent: any) => agent.cmd,
}));

vi.mock("../src/chat/store.js", () => ({
  getSession: (...args: any[]) => getSessionMock(...args),
  getMessages: (...args: any[]) => getMessagesMock(...args),
  appendMessage: (...args: any[]) => appendMessageMock(...args),
  updateSessionRuntime: vi.fn(),
}));

vi.mock("../src/services/settings.js", () => ({
  getSetting: vi.fn().mockResolvedValue("terse"),
}));

vi.mock("../src/services/knowledge.js", () => ({
  upsertSourceDoc: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/knowledge/embedder.js", () => ({
  getEmbedder: vi.fn(),
}));

import { runTurn, CHAT_CAPABILITIES, NO_TOOLS_CLAUSE } from "../src/chat/turns.js";
import { recordBrowserCall } from "../src/browser/pending-grants.js";

const fakeActor: any = { id: "a1", name: "tester", role: "admin", kind: "human" };

beforeEach(() => {
  vi.clearAllMocks();
  runAgentMock.mockResolvedValue({ ok: true, output: "agent reply" });
  getMessagesMock.mockResolvedValue([
    { role: "user", body: "hello world" },
  ]);
  appendMessageMock.mockResolvedValue(undefined);
});

describe("chat turns CLI lane prompt capability composition", () => {
  it("includes CHAT_CAPABILITIES for mcp: true agent lane", async () => {
    getSessionMock.mockResolvedValue({ id: "s1", model: "claude-cli::default", projectId: null });
    await runTurn(fakeActor, "s1", "hello world", "claude-cli::default");
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const promptArg = runAgentMock.mock.calls[0][1];
    expect(promptArg).toContain(CHAT_CAPABILITIES);
    expect(promptArg).toContain("user: hello world");
  });

  it("omits CHAT_CAPABILITIES for unwired CLI agent lane", async () => {
    getSessionMock.mockResolvedValue({ id: "s2", model: "agy::default", projectId: null });
    await runTurn(fakeActor, "s2", "hello world", "agy::default");
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const promptArg = runAgentMock.mock.calls[0][1];
    expect(promptArg).not.toContain(CHAT_CAPABILITIES);
    expect(promptArg).toContain("user: hello world");
  });

  it("includes NO_TOOLS_CLAUSE for unwired CLI agent lane", async () => {
    getSessionMock.mockResolvedValue({ id: "s3", model: "agy::default", projectId: null });
    await runTurn(fakeActor, "s3", "hello world", "agy::default");
    const promptArg = runAgentMock.mock.calls[0][1];
    expect(promptArg).toContain(NO_TOOLS_CLAUSE);
  });

  it("omits NO_TOOLS_CLAUSE for mcp: true agent lane", async () => {
    getSessionMock.mockResolvedValue({ id: "s4", model: "claude-cli::default", projectId: null });
    await runTurn(fakeActor, "s4", "hello world", "claude-cli::default");
    const promptArg = runAgentMock.mock.calls[0][1];
    expect(promptArg).not.toContain(NO_TOOLS_CLAUSE);
  });

  it("drains every browser call recorded mid-turn into the assistant message's toolCalls", async () => {
    getSessionMock.mockResolvedValue({ id: "s5", model: "claude-cli::default", projectId: null });
    // The fake CLI agent fixture cannot call back into the MCP server, so
    // simulate the server recording calls while the turn is in flight: let
    // runAgent take longer than the recordBrowserCall delay below.
    runAgentMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, output: "agent reply" }), 150)),
    );
    const turnPromise = runTurn(fakeActor, "s5", "hello world", "claude-cli::default");
    await new Promise((r) => setTimeout(r, 50));
    recordBrowserCall(fakeActor.id, { name: "browser_snapshot", summary: "ok" });
    recordBrowserCall(fakeActor.id, { name: "browser_act", summary: "refused: reason", grantOrigin: "https://x.test" });
    await turnPromise;

    const saved = appendMessageMock.mock.calls.find((c: any[]) => c[0].role === "assistant")?.[0];
    expect(saved.toolCalls).toEqual([
      { name: "browser_snapshot", input: {}, summary: "ok" },
      { name: "browser_act", input: { targetOrigin: "https://x.test" }, summary: "refused: reason", grantOrigin: "https://x.test" },
    ]);
  });
});
