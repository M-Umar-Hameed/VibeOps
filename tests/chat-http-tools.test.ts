import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import * as store from "../src/chat/store.js";
import { runTurn } from "../src/chat/turns.js";
import { createActor } from "../src/services/actors.js";
import { setSetting } from "../src/services/settings.js";
import * as configMod from "../src/relay/config.js";
import { CATALOG_CACHE } from "../src/chat/catalog.js";

process.env.EMBED_PROVIDER = "fake";

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Mock server serves two routes: GET .../models (fetchCatalog, hit once per
// http-lane turn for the per-model tool gate) and POST .../chat/completions
// (scripted per test via chatHandler, round-numbered). loadRelayConfig is
// stubbed (as tests/forge-api.test.ts does for the same reason) because the
// real loader requires an https baseUrl, and this mock server is local
// plaintext http.
describe("http lane tool wiring", () => {
  let server: Server;
  let base: string;
  let chatRequestCount = 0;
  let catalogPayload: unknown = { data: [] };
  let chatHandler: (round: number, body: any, res: any) => void = () => {};

  beforeEach(async () => {
    chatRequestCount = 0;
    catalogPayload = { data: [] };
    CATALOG_CACHE.clear();
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c));
      req.on("end", () => {
        if (req.method === "GET" && req.url?.includes("/models")) {
          res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
          res.end(JSON.stringify(catalogPayload));
          return;
        }
        chatRequestCount++;
        chatHandler(chatRequestCount, raw ? JSON.parse(raw) : {}, res);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    vi.restoreAllMocks();
  });

  function mockRelay() {
    vi.spyOn(configMod, "loadRelayConfig").mockReturnValue({
      workdir: "/tmp",
      agents: { openrouter: { cmd: [], type: "http", baseUrl: base, keySetting: "openrouterApiKey", roles: [] } },
    });
  }

  it("runs a tool round then stores the final answer with toolCalls recorded", async () => {
    mockRelay();
    await setSetting("openrouterApiKey", "k");
    chatHandler = (round, _body, res) => {
      res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
      if (round === 1) {
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "board_tickets", arguments: "{}" } }] } }],
        }));
      } else {
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "final answer" } }] }));
      }
    };

    const { actor } = await createActor({ name: uniq("http-tools"), kind: "human" });
    const sess = await store.createSession("http tools test", "openrouter::m");

    await runTurn(actor, sess.id, "list tickets");

    const msgs = await store.getMessages(sess.id);
    const assistant = msgs.find((m) => m.role === "assistant")!;
    expect(assistant.body).toBe("final answer");
    expect(assistant.toolCalls).toBeDefined();
    expect(assistant.toolCalls?.length).toBe(1);
    expect(assistant.toolCalls?.[0].name).toBe("board_tickets");
    expect(chatRequestCount).toBe(2);
  });

  it("a model the catalog marks tools:false gets no tools, streamed, with NO_TOOLS_CLAUSE", async () => {
    mockRelay();
    await setSetting("openrouterApiKey", "k");
    catalogPayload = { data: [{ id: "plain", supported_parameters: [] }] };
    let seenBody: any = null;
    chatHandler = (_round, body, res) => {
      seenBody = body;
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    };

    const { actor } = await createActor({ name: uniq("http-tools-plain"), kind: "human" });
    const sess = await store.createSession("plain model test", "openrouter::plain");

    await runTurn(actor, sess.id, "hello");

    expect(seenBody.tools).toBeUndefined();
    const sys = seenBody.messages.find((m: any) => m.role === "system")?.content ?? "";
    expect(sys).toContain("This lane has no tools.");
  });

  it("a model the catalog marks tools:true gets tools attached", async () => {
    mockRelay();
    await setSetting("openrouterApiKey", "k");
    catalogPayload = { data: [{ id: "smart", supported_parameters: ["tools"] }] };
    let seenBody: any = null;
    chatHandler = (_round, body, res) => {
      seenBody = body;
      res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
    };

    const { actor } = await createActor({ name: uniq("http-tools-smart"), kind: "human" });
    const sess = await store.createSession("smart model test", "openrouter::smart");

    await runTurn(actor, sess.id, "hello");

    expect(Array.isArray(seenBody.tools)).toBe(true);
    expect(seenBody.tools.length).toBeGreaterThan(0);
  });
});
