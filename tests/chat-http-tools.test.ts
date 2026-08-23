import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import * as store from "../src/chat/store.js";
import { runTurn } from "../src/chat/turns.js";
import { createActor } from "../src/services/actors.js";
import { setSetting } from "../src/services/settings.js";
import * as configMod from "../src/relay/config.js";

process.env.EMBED_PROVIDER = "fake";

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Two-round script: request 1 returns a tool_calls message for board_tickets,
// request 2 returns the final answer. loadRelayConfig is stubbed (as
// tests/forge-api.test.ts does for the same reason) because the real loader
// requires an https baseUrl, and this mock server is local plaintext http.
describe("http lane tool wiring", () => {
  let server: Server;
  let base: string;
  let requestCount = 0;

  beforeEach(async () => {
    requestCount = 0;
    server = createServer((req, res) => {
      requestCount++;
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
        if (requestCount === 1) {
          res.end(JSON.stringify({
            choices: [{ message: { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "board_tickets", arguments: "{}" } }] } }],
          }));
        } else {
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "final answer" } }] }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    vi.restoreAllMocks();
  });

  it("runs a tool round then stores the final answer with toolCalls recorded", async () => {
    vi.spyOn(configMod, "loadRelayConfig").mockReturnValue({
      workdir: "/tmp",
      agents: { openrouter: { cmd: [], type: "http", baseUrl: base, keySetting: "openrouterApiKey", roles: [] } },
    });
    await setSetting("openrouterApiKey", "k");

    const { actor } = await createActor({ name: uniq("http-tools"), kind: "human" });
    const sess = await store.createSession("http tools test", "openrouter::m");

    await runTurn(actor, sess.id, "list tickets");

    const msgs = await store.getMessages(sess.id);
    const assistant = msgs.find((m) => m.role === "assistant")!;
    expect(assistant.body).toBe("final answer");
    expect(assistant.toolCalls).toBeDefined();
    expect(assistant.toolCalls?.length).toBe(1);
    expect(assistant.toolCalls?.[0].name).toBe("board_tickets");
    expect(requestCount).toBe(2);
  });
});
