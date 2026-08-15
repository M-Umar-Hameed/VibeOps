import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as store from "../src/chat/store.js";
import { setChatAgent, runTurn, getChatOutput, isRunning, ChatBusyError } from "../src/chat/turns.js";
import { createActor } from "../src/services/actors.js";

process.env.EMBED_PROVIDER = "fake";

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("chat turns", () => {
  let originalAgent: any;

  beforeEach(() => {
    // Save the original (we'll restore if needed)
    originalAgent = null;
  });

  afterEach(() => {
    // Reset to default by setting a simple passthrough if we modified it
    if (originalAgent) {
      setChatAgent(originalAgent);
    }
  });

  it("runs a turn with a fake agent and persists messages", async () => {
    const { actor } = await createActor({ name: uniq("chat-turn"), kind: "human" });
    const sess = await store.createSession("turn test");

    let calledTools: any[] = [];
    setChatAgent(async (params) => {
      // Simulate calling the knowledge_search tool
      for (const t of params.tools) {
        if (t.name === "knowledge_search") {
          const result = await t.handler({ query: "test" }, {});
          calledTools.push({ name: t.name, result });
        }
      }
      params.onData?.("chunk1");
      params.onData?.("chunk2");
      return { ok: true, text: "answer from agent", sessionId: "sdk-session-1" };
    });

    await runTurn(actor, sess.id, "hello agent");

    const messages = await store.getMessages(sess.id);
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].body).toBe("hello agent");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].body).toBe("answer from agent");
    expect(messages[1].toolCalls).toBeDefined();
    expect(messages[1].toolCalls?.length).toBeGreaterThan(0);
    expect(messages[1].toolCalls?.[0].name).toBe("knowledge_search");

    // Check session got updated with sdkSessionId
    const updated = await store.getSession(sess.id);
    expect(updated?.sdkSessionId).toBe("sdk-session-1");
  });

  it("streams output via getChatOutput", async () => {
    const { actor } = await createActor({ name: uniq("chat-stream"), kind: "human" });
    const sess = await store.createSession("stream test");

    let resolveAgent: () => void;
    const blockPromise = new Promise<void>((r) => {
      resolveAgent = r;
    });

    setChatAgent(async (params) => {
      params.onData?.("AB");
      params.onData?.("CD");
      await blockPromise; // Hold open so we can poll while running
      return { ok: true, text: "ABCD" };
    });

    // Start turn in background
    const turnPromise = runTurn(actor, sess.id, "hi");

    // Wait a tick for the turn to start
    await new Promise((r) => setTimeout(r, 50));

    // Poll output while running
    const out1 = getChatOutput(sess.id, 0);
    expect(out1.status).toBe("running");
    expect(out1.chunk).toContain("AB");
    const next1 = out1.next;

    // Let it finish
    resolveAgent!();
    await turnPromise;

    const out2 = getChatOutput(sess.id, next1);
    expect(out2.status).toBe("idle");
  });

  it("throws ChatBusyError on concurrent turns", async () => {
    const { actor } = await createActor({ name: uniq("chat-busy"), kind: "human" });
    const sess = await store.createSession("busy test");

    let resolveFirst: () => void;
    const blockPromise = new Promise<void>((r) => {
      resolveFirst = r;
    });

    setChatAgent(async (params) => {
      await blockPromise;
      return { ok: true, text: "done" };
    });

    const first = runTurn(actor, sess.id, "first");

    // Wait a tick for first to start
    await new Promise((r) => setTimeout(r, 20));

    expect(isRunning(sess.id)).toBe(true);

    // Second should throw
    await expect(runTurn(actor, sess.id, "second")).rejects.toThrow(ChatBusyError);

    // Resolve first
    resolveFirst!();
    await first;

    expect(isRunning(sess.id)).toBe(false);
  });

  it("offset contract works correctly", async () => {
    const { actor } = await createActor({ name: uniq("chat-offset"), kind: "human" });
    const sess = await store.createSession("offset test");

    setChatAgent(async (params) => {
      params.onData?.("12345");
      return { ok: true, text: "12345" };
    });

    await runTurn(actor, sess.id, "go");

    const out = getChatOutput(sess.id, 0);
    expect(out.chunk).toBe("12345");
    expect(out.next).toBe(5);

    const out2 = getChatOutput(sess.id, 3);
    expect(out2.chunk).toBe("45");
    expect(out2.next).toBe(5);

    const out3 = getChatOutput(sess.id, 5);
    expect(out3.chunk).toBe("");
    expect(out3.next).toBe(5);
  });
});
