import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "../src/chat/store.js";
import { setChatAgent, runTurn, getChatOutput, isRunning, ChatBusyError, CHAT_CAPABILITIES } from "../src/chat/turns.js";
import { createActor } from "../src/services/actors.js";
import { roleStyle } from "../src/relay/style.js";
import { getSetting } from "../src/services/settings.js";

const FAKE_AGENT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-agent.mjs");

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
    if (originalAgent) setChatAgent(originalAgent);
    delete process.env.VIBEOPS_RELAY_CONFIG;
    delete process.env.FAKE_MODE;
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

  it("passes extracted image attachments to the sdk agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chat-turn-attach-"));
    process.env.VIBEOPS_ATTACHMENTS_DIR = dir;
    try {
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
        "base64",
      );
      const abs = join(dir, "shot.png");
      writeFileSync(abs, png);

      const { actor } = await createActor({ name: uniq("chat-turn-img"), kind: "human" });
      const sess = await store.createSession("img test");

      let seenImages: any;
      setChatAgent(async (params) => {
        seenImages = params.images;
        return { ok: true, text: "ok" };
      });

      await runTurn(actor, sess.id, `look at this\n\n![shot](${abs.replace(/\\/g, "/")})`);

      expect(seenImages?.length).toBe(1);
      expect(seenImages[0].mediaType).toBe("image/png");
    } finally {
      delete process.env.VIBEOPS_ATTACHMENTS_DIR;
    }
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

  it("legacy 'opus' model still runs on the sdk lane", async () => {
    const { actor } = await createActor({ name: uniq("chat-legacy"), kind: "human" });
    const sess = await store.createSession("legacy test", "opus");

    let seenModel: string | undefined;
    setChatAgent(async (params) => {
      seenModel = params.model;
      return { ok: true, text: "sdk answer", sessionId: "sdk-legacy-1" };
    });

    await runTurn(actor, sess.id, "hello");

    expect(seenModel).toBe("opus"); // sdk lane received the bare legacy model
    const msgs = await store.getMessages(sess.id);
    expect(msgs[1].body).toBe("sdk answer");
    expect((await store.getSession(sess.id))?.sdkSessionId).toBe("sdk-legacy-1");
  });

  it("CLI-lane session folds turn 1's exchange into turn 2's prompt", async () => {
    const cfgPath = join(mkdtempSync(join(tmpdir(), "chat-cli-cfg-")), "relay.json");
    writeFileSync(cfgPath, JSON.stringify({
      workdir: tmpdir(),
      agents: {
        fakecli: {
          cmd: [process.execPath, FAKE_AGENT, "{prompt}", "{model}"],
          roles: ["work"],
          models: [{ name: "fast", tier: "cheap", quality: 3 }],
        },
      },
    }));
    process.env.VIBEOPS_RELAY_CONFIG = cfgPath;
    process.env.FAKE_MODE = "echo-prompt"; // prints "PROMPT:<full prompt>"

    const { actor } = await createActor({ name: uniq("chat-cli"), kind: "human" });
    const sess = await store.createSession("cli test", "fakecli::fast");

    await runTurn(actor, sess.id, "ALPHA");
    await runTurn(actor, sess.id, "BRAVO");

    const msgs = await store.getMessages(sess.id);
    const turn2Assistant = msgs[3].body; // echo of turn 2's composed prompt
    expect(msgs[3].role).toBe("assistant");
    expect(turn2Assistant).toContain("ALPHA"); // turn 1 user message present
    expect(turn2Assistant).toContain("BRAVO"); // turn 2 user message present
    expect(turn2Assistant.startsWith("PROMPT:")).toBe(true);
  });

  it("hands the SDK agent the voice clause AND the capability section", async () => {
    const { actor } = await createActor({ name: uniq("chat-cap"), kind: "human" });
    const sess = await store.createSession("cap test");

    let seenPrompt: string | undefined;
    setChatAgent(async (params) => {
      seenPrompt = params.systemPrompt;
      return { ok: true, text: "ok" };
    });

    await runTurn(actor, sess.id, "open a github url");

    const voice = roleStyle("chat", await getSetting("agents.commProfile"));
    expect(voice.length).toBeGreaterThan(0);
    // Assert on the actual string handed to agentImpl, not a helper in isolation.
    expect(seenPrompt).toContain(voice);
    expect(seenPrompt).toContain(CHAT_CAPABILITIES);
    // ponytail: was exact equality (voice + CHAT_CAPABILITIES); speak-first memory
    // (Task 3) can now inject a fenced memory block between them, so assert the
    // relative order (voice first, capabilities last) instead of exact content.
    expect(seenPrompt?.startsWith(voice)).toBe(true);
    expect(seenPrompt?.endsWith(CHAT_CAPABILITIES)).toBe(true);
  });

  it("keeps the capability section out of other roles' voice", async () => {
    expect(roleStyle("work", null)).not.toContain(CHAT_CAPABILITIES);
    expect(roleStyle("review", null)).not.toContain(CHAT_CAPABILITIES);
  });
});

  it("a turn that throws still leaves a visible assistant error message", async () => {
    const { actor } = await createActor({ name: uniq("chat-throw"), kind: "human" });
    const sess = await store.createSession("throw test");

    setChatAgent(async () => {
      throw new Error("model exploded");
    });

    // The route calls runTurn fire-and-forget with .catch(() => {}); the failure
    // must be visible in the transcript, not swallowed into an empty chat.
    await runTurn(actor, sess.id, "hello").catch(() => {});

    const msgs = await store.getMessages(sess.id);
    const assistant = msgs.filter((m) => m.role === "assistant");
    expect(assistant.length).toBe(1);
    expect(assistant[0].body).toMatch(/turn failed/);
    expect(assistant[0].body).toContain("model exploded");
    expect(isRunning(sess.id)).toBe(false);
  });
