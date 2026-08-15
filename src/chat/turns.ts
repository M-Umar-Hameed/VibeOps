import { runChatTurn, type ChatTurnResult } from "./agent.js";
import { buildChatTools, type ToolCall } from "./tools.js";
import * as store from "./store.js";
import type { Actor } from "../db/schema.js";
import { roleStyle } from "../relay/style.js";
import { getSetting } from "../services/settings.js";
import { upsertSourceDoc } from "../services/knowledge.js";
import { getEmbedder } from "../knowledge/embedder.js";

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
    const tools = buildChatTools(actor, calls, session.projectId ?? undefined);
    const onData = (s: string) => {
      const b = live.get(sessionId)!;
      b.output += s;
    };

    const voice = roleStyle("chat", await getSetting("agents.commProfile"));
    let res: ChatTurnResult;
    try {
      res = await agentImpl({
        userBody,
        tools,
        model: useModel,
        systemPrompt: voice,
        resume: session.sdkSessionId ?? undefined,
        onData,
      });
    } catch (e) {
      // C3: stale resume -> one fresh retry
      res = await agentImpl({
        userBody,
        tools,
        model: useModel,
        systemPrompt: voice,
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

    // Fold the completed conversation into the knowledge index so later turns and
    // other sessions can retrieve it. Ref mirrors the vault rule: "<projectId>:<id>"
    // is project-scoped, a bare "<id>" is global. upsertSourceDoc deletes the ref's
    // old chunks before inserting, so re-ingesting a session never duplicates.
    // Best-effort: the turn already succeeded, so an index failure must not surface.
    try {
      const msgs = await store.getMessages(sessionId);
      const transcript = msgs.map((m) => `${m.role}: ${m.body}`).join("\n\n");
      const ref = session.projectId ? `${session.projectId}:${sessionId}` : sessionId;
      await upsertSourceDoc("chat", ref, transcript, getEmbedder());
    } catch (e) {
      console.warn(`chat transcript ingest failed for ${sessionId}: ${(e as Error).message}`);
    }
  } finally {
    const b = live.get(sessionId);
    if (b) b.status = "idle";
    running.delete(sessionId);
  }
}
