import { runChatTurn, type ChatTurnResult } from "./agent.js";
import { buildChatTools, type ToolCall } from "./tools.js";
import * as store from "./store.js";
import type { Actor } from "../db/schema.js";
import { roleStyle } from "../relay/style.js";
import { getSetting } from "../services/settings.js";
import { upsertSourceDoc } from "../services/knowledge.js";
import { getEmbedder } from "../knowledge/embedder.js";
import { runAgent } from "../relay/invoke.js";
import { loadRelayConfig, resolveCmd } from "../relay/config.js";
import { parseModelRef, rollTranscript } from "./roster.js";

// Composed onto the chat voice clause for the tool-capable SDK lane only. States
// what the connected tools can do and the act-grant rule, so the agent stops
// denying capabilities it has (live incident: extension linked, agent claimed it
// could not open a URL). Describes capability classes, not tool names, so it does
// not rot as the tool set changes.
export const CHAT_CAPABILITIES = `
Your tools connect you to this app's own surfaces. With a linked browser extension you can snapshot and read the current page, and you can act on it: click, type, select, press keys, and navigate to an http/https URL. You can also search the knowledge index and list board tickets. Do not tell the owner you cannot open a URL or drive the browser when an extension is connected; those actions are available to you.

Acting on a page and navigating both require an "act" grant for the target origin, and for navigation the grant must cover the DESTINATION origin. Whether a grant exists is decided server-side, not by you.

If an action is refused because a grant is missing, the refusal states the exact setting to add. Relay that refusal to the owner word for word; do not paraphrase it or substitute a limitation of your own. When you are unsure whether an action will be permitted, attempt it and report the actual result or refusal rather than declining up front.
`;

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

    const onData = (s: string) => {
      const b = live.get(sessionId)!;
      b.output += s;
    };
    const voice = roleStyle("chat", await getSetting("agents.commProfile"));

    const { agent: agentName, model: modelName } = parseModelRef(useModel);
    const config = agentName ? loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG) : undefined;
    const agentDef = agentName ? config!.agents[agentName] : undefined;

    let res: ChatTurnResult;
    const calls: ToolCall[] = [];

    if (!agentName || agentDef?.type === "sdk") {
      // SDK lane: tool-capable, resumable. Legacy 'sonnet'/'opus' land here (no '::').
      const tools = buildChatTools(actor, calls, session.projectId ?? undefined);
      const systemPrompt = voice + CHAT_CAPABILITIES;
      try {
        res = await agentImpl({
          userBody, tools, model: modelName, systemPrompt,
          resume: session.sdkSessionId ?? undefined, onData,
        });
      } catch (e) {
        // C3: stale resume -> one fresh retry
        res = await agentImpl({ userBody, tools, model: modelName, systemPrompt, onData });
      }
      if (res.sessionId) {
        await store.updateSessionRuntime(sessionId, { sdkSessionId: res.sessionId });
      }
    } else if (!agentDef) {
      res = { ok: false, text: `[chat: unknown agent "${agentName}" in relay config]` };
      onData(res.text);
    } else {
      // CLI lane: one-shot process. An mcp-wired lane reaches the shared MCP tools
      // through its own CLI MCP client config (one-time `claude mcp add --transport
      // http vibeops <url>`; see docs/AGENT_CLIS.md), so no flags or secrets are
      // injected here. Surface CHAT_CAPABILITIES so a wired lane stops denying tools
      // it has; an unwired lane gets voice only and makes no tool claims.
      const cliAgent = { ...agentDef, cmd: resolveCmd(agentDef, modelName || undefined) };
      const transcript = rollTranscript(await store.getMessages(sessionId));
      const sys = agentDef.mcp ? `${voice}${CHAT_CAPABILITIES}` : voice;
      const prompt = sys ? `${sys}\n\n${transcript}` : transcript;
      const out = await runAgent(cliAgent, prompt, config!.workdir, onData);
      res = { ok: out.ok, text: out.output };
    }

    await store.appendMessage({
      sessionId,
      role: "assistant",
      body: res.text,
      toolCalls: calls.length ? calls : undefined,
    });

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
