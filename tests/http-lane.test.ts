import { afterAll, beforeEach, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { runHttpTurn, type ToolDef } from "../src/chat/http-lane.js";

// Mock OpenAI-compatible endpoint. Each test points baseUrl at it and controls
// the response via the handler set below. requestCount lets multi-round tests
// script a different response per POST.
let handler: (req: any, res: any, body: string) => void = () => {};
let requestCount = 0;
beforeEach(() => { requestCount = 0; });
const server: Server = createServer((req, res) => {
  requestCount++;
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

test("images are attached as image_url parts alongside the transcript text", async () => {
  let seenBody: any = null;
  handler = (_req, res, body) => {
    seenBody = JSON.parse(body);
    sse(res, [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  };
  const res = await runHttpTurn({
    baseUrl: BASE, apiKey: "k", model: "m", system: "", transcript: "user: look at this",
    onData: () => {},
    images: [{ mediaType: "image/png", data: "aGVsbG8=" }],
  });
  expect(res.ok).toBe(true);
  const userMsg = seenBody.messages.find((m: any) => m.role === "user");
  expect(Array.isArray(userMsg.content)).toBe(true);
  expect(userMsg.content[0]).toEqual({ type: "text", text: "user: look at this" });
  expect(userMsg.content[1].type).toBe("image_url");
  expect(userMsg.content[1].image_url.url).toMatch(/^data:image\/png;base64,aGVsbG8=$/);
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

function json(res: any, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
  res.end(JSON.stringify(body));
}

function toolCallMsg(name: string, args: string, id = "call_1") {
  return { choices: [{ message: { role: "assistant", tool_calls: [{ id, type: "function", function: { name, arguments: args } }] } }] };
}

const snapshotTool: ToolDef = {
  name: "browser_snapshot",
  description: "snapshot",
  parameters: { type: "object", properties: {} },
  run: async () => "SNAP",
};

test("tool round then answer: sends the tool result back and returns the final text", async () => {
  let seenSecondBody: any = null;
  handler = (_req, res, body) => {
    if (requestCount === 1) {
      json(res, 200, toolCallMsg("browser_snapshot", "{}"));
    } else {
      seenSecondBody = JSON.parse(body);
      json(res, 200, { choices: [{ message: { role: "assistant", content: "done" } }] });
    }
  };
  const got: string[] = [];
  const res = await runHttpTurn({
    baseUrl: BASE, apiKey: "k", model: "m", system: "", transcript: "user: snapshot",
    onData: (s) => got.push(s), tools: [snapshotTool],
  });
  expect(res).toEqual({ ok: true, text: "done" });
  expect(got.join("")).toBe("done");
  const toolMsg = seenSecondBody.messages.find((m: any) => m.role === "tool");
  expect(toolMsg).toBeDefined();
  expect(toolMsg.content).toBe("SNAP");
});

test("images travel into the tool loop's initial user message too", async () => {
  let seenFirstBody: any = null;
  handler = (_req, res, body) => {
    if (requestCount === 1) {
      seenFirstBody = JSON.parse(body);
      json(res, 200, { choices: [{ message: { role: "assistant", content: "done" } }] });
    }
  };
  const res = await runHttpTurn({
    baseUrl: BASE, apiKey: "k", model: "m", system: "", transcript: "user: hi",
    onData: () => {}, tools: [snapshotTool],
    images: [{ mediaType: "image/png", data: "aGVsbG8=" }],
  });
  expect(res.ok).toBe(true);
  const userMsg = seenFirstBody.messages.find((m: any) => m.role === "user");
  expect(Array.isArray(userMsg.content)).toBe(true);
  expect(userMsg.content[1].image_url.url).toMatch(/^data:image\/png;base64,aGVsbG8=$/);
});

test("an unknown tool name resolves to an 'unknown tool' result", async () => {
  handler = (_req, res, body) => {
    if (requestCount === 1) {
      json(res, 200, toolCallMsg("no_such_tool", "{}"));
    } else {
      const parsed = JSON.parse(body);
      const toolMsg = parsed.messages.find((m: any) => m.role === "tool");
      json(res, 200, { choices: [{ message: { role: "assistant", content: toolMsg.content } }] });
    }
  };
  const res = await runHttpTurn({
    baseUrl: BASE, apiKey: "k", model: "m", system: "", transcript: "user: hi",
    onData: () => {}, tools: [snapshotTool],
  });
  expect(res.ok).toBe(true);
  expect(res.text).toMatch(/^unknown tool/);
});

test("bad JSON tool arguments resolve to an 'invalid arguments' result", async () => {
  handler = (_req, res, body) => {
    if (requestCount === 1) {
      json(res, 200, toolCallMsg("browser_snapshot", "{not json"));
    } else {
      const parsed = JSON.parse(body);
      const toolMsg = parsed.messages.find((m: any) => m.role === "tool");
      json(res, 200, { choices: [{ message: { role: "assistant", content: toolMsg.content } }] });
    }
  };
  const res = await runHttpTurn({
    baseUrl: BASE, apiKey: "k", model: "m", system: "", transcript: "user: hi",
    onData: () => {}, tools: [snapshotTool],
  });
  expect(res.ok).toBe(true);
  expect(res.text).toMatch(/^invalid arguments/);
});

test("hitting the round cap stops after 8 requests and reports the overrun", async () => {
  handler = (_req, res) => json(res, 200, toolCallMsg("browser_snapshot", "{}"));
  const got: string[] = [];
  const res = await runHttpTurn({
    baseUrl: BASE, apiKey: "k", model: "m", system: "", transcript: "user: hi",
    onData: (s) => got.push(s), tools: [snapshotTool],
  });
  expect(res.ok).toBe(false);
  expect(res.text).toContain("exceeded 8 rounds");
  expect(requestCount).toBe(8);
  // onData gets the cap text too, like every other terminal path, so the
  // live output buffer isn't left empty for a turn that failed this way.
  expect(got.join("")).toContain("exceeded 8 rounds");
});

test("a tool whose run() throws yields a 'tool error:' result and the loop continues", async () => {
  const throwingTool: ToolDef = {
    name: "browser_snapshot",
    description: "snapshot",
    parameters: { type: "object", properties: {} },
    run: async () => { throw new Error("boom"); },
  };
  let seenSecondBody: any = null;
  handler = (_req, res, body) => {
    if (requestCount === 1) {
      json(res, 200, toolCallMsg("browser_snapshot", "{}"));
    } else {
      seenSecondBody = JSON.parse(body);
      json(res, 200, { choices: [{ message: { role: "assistant", content: "done" } }] });
    }
  };
  const res = await runHttpTurn({
    baseUrl: BASE, apiKey: "k", model: "m", system: "", transcript: "user: hi",
    onData: () => {}, tools: [throwingTool],
  });
  expect(res).toEqual({ ok: true, text: "done" });
  const toolMsg = seenSecondBody.messages.find((m: any) => m.role === "tool");
  expect(toolMsg.content).toMatch(/^tool error:/);
  expect(toolMsg.content).toContain("boom");
});

test("a 400 naming missing tool support surfaces verbatim even with tools attached", async () => {
  handler = (_req, res) => json(res, 400, { error: { message: "No endpoints found that support tool use" } });
  const res = await runHttpTurn({
    baseUrl: BASE, apiKey: "k", model: "m", system: "", transcript: "user: hi",
    onData: () => {}, tools: [snapshotTool],
  });
  expect(res.ok).toBe(false);
  expect(res.text).toContain("No endpoints found that support tool use");
});

test("an empty final message after a tool round falls back to a readable placeholder instead of a blank bubble", async () => {
  handler = (_req, res, body) => {
    if (requestCount === 1) {
      json(res, 200, toolCallMsg("browser_snapshot", "{}"));
    } else {
      const parsed = JSON.parse(body);
      const toolMsg = parsed.messages.find((m: any) => m.role === "tool");
      expect(toolMsg.content).toBe("SNAP");
      json(res, 200, { choices: [{ message: { role: "assistant", content: "" } }] });
    }
  };
  const got: string[] = [];
  const res = await runHttpTurn({
    baseUrl: BASE, apiKey: "k", model: "m", system: "", transcript: "user: snapshot",
    onData: (s) => got.push(s), tools: [snapshotTool],
  });
  expect(res).toEqual({ ok: true, text: "[no text reply from the model; its tool calls are shown above]" });
  expect(got.join("")).toBe("[no text reply from the model; its tool calls are shown above]");
});

test("a null content final message after a tool round also falls back to the placeholder", async () => {
  handler = (_req, res) => {
    if (requestCount === 1) {
      json(res, 200, toolCallMsg("browser_snapshot", "{}"));
    } else {
      json(res, 200, { choices: [{ message: { role: "assistant", content: null } }] });
    }
  };
  const res = await runHttpTurn({
    baseUrl: BASE, apiKey: "k", model: "m", system: "", transcript: "user: snapshot",
    onData: () => {}, tools: [snapshotTool],
  });
  expect(res.text).toBe("[no text reply from the model; its tool calls are shown above]");
});

test("an empty final message with NO prior tool round returns empty text unchanged", async () => {
  handler = (_req, res) => json(res, 200, { choices: [{ message: { role: "assistant", content: "" } }] });
  const res = await runHttpTurn({
    baseUrl: BASE, apiKey: "k", model: "m", system: "", transcript: "user: hi",
    onData: () => {}, tools: [snapshotTool],
  });
  expect(res).toEqual({ ok: true, text: "" });
});

test("a completed streaming turn with zero characters falls back to the readable placeholder", async () => {
  handler = (_req, res) => sse(res, ["data: [DONE]\n\n"]);
  const got: string[] = [];
  const res = await runHttpTurn({
    baseUrl: BASE, apiKey: "k", model: "m", system: "", transcript: "user: hi",
    onData: (s) => got.push(s),
  });
  expect(res).toEqual({ ok: true, text: "[no text reply from the model; its tool calls are shown above]" });
  expect(got.join("")).toBe("[no text reply from the model; its tool calls are shown above]");
});
