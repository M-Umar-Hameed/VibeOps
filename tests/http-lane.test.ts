import { afterAll, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { runHttpTurn } from "../src/chat/http-lane.js";

// Mock OpenAI-compatible endpoint. Each test points baseUrl at it and controls
// the response via the handler set below.
let handler: (req: any, res: any, body: string) => void = () => {};
const server: Server = createServer((req, res) => {
  let body = "";
  req.on("data", (c: Buffer) => (body += c));
  req.on("end", () => handler(req, res, body));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const BASE = `http://127.0.0.1:${port}/v1`;
afterAll(() => server.close());

function sse(res: any, chunks: string[]) {
  res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
  for (const c of chunks) res.write(c);
  res.end();
}

test("streams deltas to onData and returns the joined text", async () => {
  let seenAuth = "";
  let seenBody: any = null;
  handler = (req, res, body) => {
    seenAuth = req.headers.authorization;
    seenBody = JSON.parse(body);
    sse(res, [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  };
  const got: string[] = [];
  const res = await runHttpTurn({
    baseUrl: BASE, apiKey: "sk-or-test", model: "deepseek/deepseek-chat",
    system: "be brief", transcript: "user: hi",
    onData: (s) => got.push(s),
  });
  expect(res).toEqual({ ok: true, text: "Hello" });
  expect(got.join("")).toBe("Hello");
  expect(seenAuth).toBe("Bearer sk-or-test");
  expect(seenBody.model).toBe("deepseek/deepseek-chat");
  expect(seenBody.stream).toBe(true);
  // System prompt travels as a system message, transcript as the user message.
  expect(seenBody.messages[0]).toEqual({ role: "system", content: "be brief" });
  expect(seenBody.messages[1].role).toBe("user");
  expect(seenBody.messages[1].content).toContain("user: hi");
});

test("a 401 surfaces as a readable failure naming the key setting", async () => {
  handler = (_req, res) => {
    res.writeHead(401, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
  };
  const res = await runHttpTurn({
    baseUrl: BASE, apiKey: "bad", model: "m", system: "", transcript: "user: hi",
    onData: () => {},
  });
  expect(res.ok).toBe(false);
  expect(res.text).toMatch(/401/);
  expect(res.text).toMatch(/Invalid API key/);
});

test("a mid-stream drop returns what arrived, marked failed", async () => {
  handler = (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "par" } }] })}\n\n`);
    res.end(); // stream ends before [DONE] - truncated answer
  };
  const res = await runHttpTurn({
    baseUrl: BASE, apiKey: "k", model: "m", system: "", transcript: "user: hi",
    onData: () => {},
  });
  expect(res.ok).toBe(false);
  expect(res.text).toContain("par");
});

test("an SSE frame split across network chunks still parses", async () => {
  handler = async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
    const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: "whole" } }] })}\n\n`;
    res.write(frame.slice(0, 15));
    await new Promise((r) => setTimeout(r, 20));
    res.write(frame.slice(15));
    res.write("data: [DONE]\n\n");
    res.end();
  };
  const res = await runHttpTurn({
    baseUrl: BASE, apiKey: "k", model: "m", system: "", transcript: "user: hi",
    onData: () => {},
  });
  expect(res).toEqual({ ok: true, text: "whole" });
});
