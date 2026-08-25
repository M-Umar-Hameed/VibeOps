import { runChatTurn, type ChatTurnResult } from "./agent.js";
import { extractImageAttachments } from "./attachments.js";
import { buildChatTools, type ToolCall } from "./tools.js";
import * as store from "./store.js";
import type { Actor } from "../db/schema.js";
import { roleStyle } from "../relay/style.js";
import { getSetting } from "../services/settings.js";
import { upsertSourceDoc } from "../services/knowledge.js";
import { getEmbedder } from "../knowledge/embedder.js";
import { runAgent } from "../relay/invoke.js";
import { runHttpTurn } from "./http-lane.js";
import { toHttpTools } from "./openai-tools.js";
import { fetchCatalog } from "./catalog.js";
import { loadRelayConfig, resolveCmd } from "../relay/config.js";
import { parseModelRef, rollTranscript } from "./roster.js";
import { recallBlock } from "../services/recall.js";
import { fenceUntrusted, UNTRUSTED_CLAUSE } from "../relay/prompts.js";
import { captureMemory } from "../services/memory-capture.js";
import { HANDOFF_RE, saveHandoff } from "../services/handoff.js";
import { drainBrowserCalls } from "../browser/pending-grants.js";

// Composed onto the chat voice clause for the tool-capable SDK lane only. States
// what the connected tools can do and the act-grant rule, so the agent stops
// denying capabilities it has (live incident: extension linked, agent claimed it
// could not open a URL). Describes capability classes, not tool names, so it does
// not rot as the tool set changes.
export const CHAT_CAPABILITIES = `
Your tools connect you to this app's own surfaces. With a linked browser extension you can snapshot and read the current page, and you can act on it: click, type, select, press keys, and navigate to an http/https URL. You can also list the open tabs, open a URL in a NEW tab, and switch to another tab; page actions then apply to whichever tab is active. You can also search the knowledge index and list board tickets. Do not tell the owner you cannot open a URL or drive the browser when an extension is connected; those actions are available to you.

Acting on a page, navigating, and opening a new tab all require an "act" grant for the target origin, and for navigation or a new tab the grant must cover the DESTINATION origin. Whether a grant exists is decided server-side, not by you.

If an action is refused because a grant is missing, the refusal states the exact setting to add. Relay that refusal to the owner word for word; do not paraphrase it or substitute a limitation of your own. When you are unsure whether an action will be permitted, attempt it and report the actual result or refusal rather than declining up front. After a grant refusal the owner sees Allow once / Always allow / Deny buttons under your reply; tell them to use those buttons rather than editing settings by hand.

Talk to the owner in plain language: what you did, what happened, what they can do next. Never explain protocol internals - verbs, step objects, dispatchers, builds, JSON - unless they ask. When a tool result tells the owner to change a Chrome setting or update the extension, pass that instruction on as written and stop there.

Never say you are navigating, clicking, typing or opening anything unless a tool result in this same turn confirms it happened; if you did not call a tool, say plainly that you did not act. The browser actions run in a separate VibeOps window, never in the owner's own tabs.
`;

// Composed onto the voice clause for a CLI lane with no verified tool mechanism
// (mcp !== true). Without this, an unwired lane's model has narrated actions
// it cannot take (live incident: "taking a snapshot", "navigating to
// zapier.com" on a lane with no tools at all).
export const NO_TOOLS_CLAUSE = "\nThis lane has no tools. You cannot read pages, drive the browser, search the board, or save anything. Never say you are doing or have done such an action; say plainly that this model has no tools here and suggest a tool-capable model.";

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

    // *handoff never reaches the model: it stores "where we left off" for the
    // next session and replies with what it stored.
    if (HANDOFF_RE.test(userBody)) {
      let reply: string;
      if (!session.projectId) {
        reply = "[chat: *handoff needs a project: this session has none. Pick a project for the chat and retry.]";
      } else {
        const given = userBody.replace(HANDOFF_RE, "").trim();
        const prior = (await store.getMessages(sessionId)).filter((m) => m.role === "assistant").at(-1)?.body ?? "";
        const body = `${session.title ?? "Chat"}: ${given || prior || "(nothing to hand off)"}`;
        const saved = await saveHandoff(actor.id, session.projectId, body);
        reply = `Handoff saved (${saved.id.slice(0, 8)}):\n${body}`;
      }
      const b = live.get(sessionId)!;
      b.output += reply;
      await store.appendMessage({ sessionId, role: "assistant", body: reply });
      return;
    }

    const onData = (s: string) => {
      const b = live.get(sessionId)!;
      b.output += s;
    };
    const images = extractImageAttachments(userBody);
    const voice = roleStyle("chat", await getSetting("agents.commProfile"));

    // Speak-first memory: rules and decisions the model would otherwise have
    // to remember to search for. Fail-open: a dead index must not block a turn.
    let memory = "";
    try {
      memory = await recallBlock(userBody, { projectId: session.projectId ?? undefined });
    } catch (e) {
      console.warn(`chat: recall failed for ${sessionId}: ${(e as Error).message}`);
    }
    const sysBase = memory ? `${voice}\n${fenceUntrusted("memory", memory)}\n${UNTRUSTED_CLAUSE}` : voice;

    const { agent: agentName, model: modelName } = parseModelRef(useModel);
    const config = agentName ? loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG) : undefined;
    const agentDef = agentName ? config!.agents[agentName] : undefined;

    let res: ChatTurnResult;
    const calls: ToolCall[] = [];

    if (!agentName || agentDef?.type === "sdk") {
      // SDK lane: tool-capable, resumable. Legacy 'sonnet'/'opus' land here (no '::').
      const tools = buildChatTools(actor, calls, session.projectId ?? undefined, sessionId);
      const systemPrompt = sysBase + CHAT_CAPABILITIES;
      try {
        res = await agentImpl({
          userBody, tools, model: modelName, systemPrompt, images,
          resume: session.sdkSessionId ?? undefined, onData,
        });
      } catch (e) {
        // C3: stale resume -> one fresh retry
        res = await agentImpl({ userBody, tools, model: modelName, systemPrompt, images, onData });
      }
      if (res.sessionId) {
        await store.updateSessionRuntime(sessionId, { sdkSessionId: res.sessionId });
      }
    } else if (!agentDef) {
      res = { ok: false, text: `[chat: unknown agent "${agentName}" in relay config]` };
      onData(res.text);
    } else if (agentDef.type === "http") {
      // HTTP lane (OpenRouter): chat-only, transcript is the context, tools below.
      const key = agentDef.keySetting ? await getSetting(agentDef.keySetting) : null;
      if (!key) {
        res = { ok: false, text: `[chat: no API key saved for "${agentName}". Add it in Settings (${agentDef.keySetting}).]` };
        onData(res.text);
      } else if (!modelName) {
        res = { ok: false, text: `[chat: pick a model for "${agentName}" - it has no default.]` };
        onData(res.text);
      } else {
        // Gate tools per model: a provider entry explicitly marked tools:false
        // gets NO tools (streaming path, NO_TOOLS_CLAUSE) so it never narrates
        // actions it silently can't take. Anything else - the entry says
        // tools:true, or the model isn't in the catalog (catalog down/unknown
        // id) - gets the real tools + CHAT_CAPABILITIES, same as the sdk lane.
        const transcript = rollTranscript(await store.getMessages(sessionId));
        const catalog = await fetchCatalog(agentDef.baseUrl!, key);
        const modelHasTools = catalog.find((m) => m.id === modelName)?.tools ?? true;
        const tools = modelHasTools
          ? toHttpTools(buildChatTools(actor, calls, session.projectId ?? undefined, sessionId))
          : undefined;
        res = await runHttpTurn({
          baseUrl: agentDef.baseUrl!, apiKey: key, model: modelName,
          system: sysBase + (modelHasTools ? CHAT_CAPABILITIES : NO_TOOLS_CLAUSE),
          transcript, onData,
          timeoutMs: agentDef.timeoutMs,
          tools, images,
        });
      }
    } else {
      // CLI lane: one-shot process. An mcp-wired lane reaches the shared MCP tools
      // through its own CLI MCP client config (one-time `claude mcp add --transport
      // http vibeops <url>`; see docs/AGENT_CLIS.md), so no flags or secrets are
      // injected here. Surface CHAT_CAPABILITIES so a wired lane stops denying tools
      // it has; an unwired lane gets NO_TOOLS_CLAUSE so it stops narrating actions
      // it cannot take.
      const cliAgent = { ...agentDef, cmd: resolveCmd(agentDef, modelName || undefined) };
      const transcript = rollTranscript(await store.getMessages(sessionId));
      const sys = agentDef.mcp ? `${sysBase}${CHAT_CAPABILITIES}` : `${sysBase}${NO_TOOLS_CLAUSE}`;
      const prompt = sys ? `${sys}\n\n${transcript}` : transcript;
      const turnStart = Date.now();
      const out = await runAgent(cliAgent, prompt, config!.workdir, onData);
      res = { ok: out.ok, text: out.output };

      // The CLI agent reaches MCP tools through its own client, so runAgent never
      // sees the browser calls it made. Drain what the server recorded for this
      // actor during the turn and surface it the same way the SDK lane's
      // buildChatTools does, so the owner sees the full trace - and gets the
      // Allow prompt for a missing grant - here too. De-dupe grant prompts by
      // origin so retries within one turn produce a single prompt; other calls
      // are appended as-is, in order.
      const seen = new Set<string>();
      for (const c of drainBrowserCalls(actor.id, turnStart)) {
        if (c.grantOrigin) {
          if (seen.has(c.grantOrigin)) continue;
          seen.add(c.grantOrigin);
        }
        calls.push({
          name: c.name,
          input: c.grantOrigin ? { targetOrigin: c.grantOrigin } : {},
          summary: c.summary,
          ...(c.grantOrigin ? { grantOrigin: c.grantOrigin } : {}),
        });
      }
    }

    await store.appendMessage({
      sessionId,
      role: "assistant",
      body: res.text,
      toolCalls: calls.length ? calls : undefined,
    });

    // Background: never awaited, never affects the turn.
    void captureMemory({
      actorId: actor.id,
      text: `user: ${userBody}\n\nassistant: ${res.text}`,
      projectId: session.projectId ?? undefined,
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
  } catch (e) {
    // The route calls runTurn fire-and-forget, so an exception here would
    // otherwise vanish: no assistant message, chat just sits there looking
    // ignored. Persist the failure where the user will actually see it.
    const msg = `[chat: turn failed: ${(e as Error).message}]`;
    const b = live.get(sessionId);
    if (b) b.output += msg;
    await store.appendMessage({ sessionId, role: "assistant", body: msg }).catch(() => {});
  } finally {
    const b = live.get(sessionId);
    if (b) b.status = "idle";
    running.delete(sessionId);
  }
}
