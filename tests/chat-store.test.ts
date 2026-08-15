import { describe, it, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import * as store from "../src/chat/store.js";
import { db } from "../src/db/client.js";
import { projects } from "../src/db/schema.js";

process.env.EMBED_PROVIDER = "fake";

describe("chat store", () => {
  it("creates, gets, and lists sessions", async () => {
    const sess = await store.createSession("test session", "sonnet");
    expect(sess.id).toBeDefined();
    expect(sess.title).toBe("test session");
    expect(sess.model).toBe("sonnet");

    const got = await store.getSession(sess.id);
    expect(got).toMatchObject({ id: sess.id, title: "test session" });

    const list = await store.listSessions();
    expect(list.find((s) => s.id === sess.id)).toBeTruthy();
  });

  it("appends and retrieves messages with toolCalls", async () => {
    const sess = await store.createSession("msg test");
    await store.appendMessage({ sessionId: sess.id, role: "user", body: "hello" });
    await store.appendMessage({
      sessionId: sess.id,
      role: "assistant",
      body: "hi there",
      toolCalls: [{ name: "test_tool", input: { foo: 1 }, summary: "tested" }],
    });

    const messages = await store.getMessages(sess.id);
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].body).toBe("hello");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].toolCalls).toEqual([
      { name: "test_tool", input: { foo: 1 }, summary: "tested" },
    ]);
  });

  it("updates session runtime fields", async () => {
    const sess = await store.createSession("update test", "sonnet");
    await store.updateSessionRuntime(sess.id, { model: "opus", sdkSessionId: "sdk-123" });

    const updated = await store.getSession(sess.id);
    expect(updated?.model).toBe("opus");
    expect(updated?.sdkSessionId).toBe("sdk-123");
  });

  it("persists projectId and listSessions/getSession return it", async () => {
    const pid = randomUUID();
    // projects FK: create a real project row so the FK holds.
    const [proj] = await db.insert(projects).values({ key: `p-${pid.slice(0,8)}`, name: "P" }).returning();
    const s = await store.createSession("scoped", "sonnet", proj.id);
    expect(s.projectId).toBe(proj.id);
    const got = await store.getSession(s.id);
    expect(got?.projectId).toBe(proj.id);

    const nullSess = await store.createSession("global", "sonnet", null);
    expect(nullSess.projectId).toBeNull();
  });
});
