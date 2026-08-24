import { afterAll, beforeEach, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { runHttpAgent } from "../src/relay/http-agent.js";
import { runAgent } from "../src/relay/dispatch.js";
import { withSetting } from "./helpers/settings.js";
import type { RelayAgent } from "../src/relay/config.js";

// Mock OpenAI-compatible completion endpoint, same shape as tests/http-lane.test.ts.
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

function json(res: any, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
  res.end(JSON.stringify(body));
}

const agent: RelayAgent = {
  cmd: [], roles: ["plan"], type: "http", baseUrl: BASE, keySetting: "orTestKey",
};

test("posts a single user message and returns the completion, calling onData once", async () => {
  let seenAuth = "";
  let seenBody: any = null;
  handler = (req, res, body) => {
    seenAuth = req.headers.authorization;
    seenBody = JSON.parse(body);
    json(res, 200, { choices: [{ message: { content: "the plan" } }] });
  };
  const got: string[] = [];
  const res = await withSetting("orTestKey", "sk-or-test", () =>
    runHttpAgent(agent, "compose a plan", "deepseek/deepseek-chat", (s) => got.push(s)),
  );
  expect(res).toEqual({ ok: true, output: "the plan" });
  expect(got).toEqual(["the plan"]);
  expect(seenAuth).toBe("Bearer sk-or-test");
  expect(seenBody).toEqual({ model: "deepseek/deepseek-chat", stream: false, messages: [{ role: "user", content: "compose a plan" }] });
});

test("no key saved reports a readable failure naming the keySetting, without a request", async () => {
  const unsetAgent: RelayAgent = { ...agent, keySetting: "neverSetKey" };
  const res = await runHttpAgent(unsetAgent, "prompt", "m", () => {});
  expect(res).toEqual({ ok: false, output: "[forge: no API key saved for neverSetKey]" });
  expect(requestCount).toBe(0);
});

test("a non-2xx response surfaces the provider's error message", async () => {
  handler = (_req, res) => json(res, 401, { error: { message: "Invalid API key" } });
  const res = await withSetting("orTestKey", "sk-or-test", () =>
    runHttpAgent(agent, "prompt", "m", () => {}),
  );
  expect(res.ok).toBe(false);
  expect(res.output).toMatch(/401/);
  expect(res.output).toMatch(/Invalid API key/);
});

test("a request that exceeds the agent's timeout fails with a readable message", async () => {
  handler = (_req, res) => {
    // Never respond -- forces the AbortSignal.timeout to fire.
    void res;
  };
  const slowAgent: RelayAgent = { ...agent, timeoutMs: 50 };
  const res = await withSetting("orTestKey", "sk-or-test", () =>
    runHttpAgent(slowAgent, "prompt", "m", () => {}),
  );
  expect(res.ok).toBe(false);
  expect(res.output).toContain(BASE);
});

test("dispatch.ts: an http lane with no model resolved fails readably, without a request", async () => {
  const res = await runAgent(agent, "prompt", "/workdir");
  expect(res).toEqual({ ok: false, output: "[forge: no model saved for this http lane; save at least one model on the lane]" });
  expect(requestCount).toBe(0);
});
