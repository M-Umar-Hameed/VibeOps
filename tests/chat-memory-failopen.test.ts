import { expect, test, vi } from "vitest";
vi.mock("../src/services/recall.js", () => ({
  recallBlock: async () => { throw new Error("index down"); },
}));
import * as store from "../src/chat/store.js";
import { setChatAgent, runTurn } from "../src/chat/turns.js";
import { createActor } from "../src/services/actors.js";

process.env.EMBED_PROVIDER = "fake";

test("a recall failure does not fail the turn", async () => {
  const { actor } = await createActor({ name: `chat-mem-fail-${Date.now()}`, kind: "human" });
  const sess = await store.createSession("mem2", "sonnet");
  setChatAgent(async () => ({ ok: true, text: "still answered" }));
  await runTurn(actor, sess.id, "hello");
  const msgs = await store.getMessages(sess.id);
  expect(msgs.at(-1)?.body).toBe("still answered");
});
