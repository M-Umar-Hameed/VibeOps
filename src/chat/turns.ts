import { runChatTurn, type ChatTurnResult } from "./agent.js";
import { buildChatTools, type ToolCall } from "./tools.js";
import * as store from "./store.js";
import type { Actor } from "../db/schema.js";

type AgentFn = (p: Parameters<typeof runChatTurn>[0]) => Promise<ChatTurnResult>;

// ponytail: test seam only
let agentImpl: AgentFn = runChatTurn;
export function setChatAgent(fn: AgentFn) {
  agentImpl = fn;
}

export class ChatBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatBusyError";
  }
}

const running = new Set<string>();
const live = new Map<string, { output: string; status: "running" | "idle" }>();

export function isRunning(sessionId: string) {
  return running.has(sessionId);
}

export function getChatOutput(sessionId: string, after: number) {
  const buf = live.get(sessionId);
  const out = buf?.output ?? "";
  const from = Math.max(0, Math.min(after, out.length));
  return { chunk: out.slice(from), next: out.length, status: buf?.status ?? "idle" };
}

export async function runTurn(
  actor: Actor,
  sessionId: string,
  userBody: string,
  model?: string,
): Promise<void> {
  if (running.has(sessionId)) {
    throw new ChatBusyError("a turn is already running for this session");
  }
  running.add(sessionId);
  live.set(sessionId, { output: "", status: "running" });

  try {
    const session = await store.getSession(sessionId);
    if (!session) throw new Error("session not found");

    if (model && model !== session.model) {
      await store.updateSessionRuntime(sessionId, { model });
    }
    const useModel = model ?? session.model;

    await store.appendMessage({ sessionId, role: "user", body: userBody });

    const calls: ToolCall[] = [];
    const tools = buildChatTools(actor, calls);
    const onData = (s: string) => {
      const b = live.get(sessionId)!;
      b.output += s;
    };

    let res: ChatTurnResult;
    try {
      res = await agentImpl({
        userBody,
        tools,
        model: useModel,
        resume: session.sdkSessionId ?? undefined,
        onData,
      });
    } catch (e) {
      // C3: stale resume -> one fresh retry
      res = await agentImpl({
        userBody,
        tools,
        model: useModel,
        onData,
      });
    }

    await store.appendMessage({
      sessionId,
      role: "assistant",
      body: res.text,
      toolCalls: calls.length ? calls : undefined,
    });

    if (res.sessionId) {
      await store.updateSessionRuntime(sessionId, { sdkSessionId: res.sessionId });
    }
  } finally {
    const b = live.get(sessionId);
    if (b) b.status = "idle";
    running.delete(sessionId);
  }
}
