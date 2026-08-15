import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { query, createSdkMcpServer, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";

const OUTPUT_CAP = 100_000;

// Credential check copied from invoke-sdk.ts — env token OR the CLI login file.
function hasCredentials(): boolean {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  return existsSync(path.join(homedir(), ".claude", ".credentials.json"));
}

export type ChatTurnResult = {
  ok: boolean;
  text: string;
  sessionId?: string;
  usage?: { tokens: number; cost: number };
};

export async function runChatTurn(params: {
  userBody: string;
  tools: SdkMcpToolDefinition<any>[];
  model: string; // "sonnet" | "opus"
  resume?: string;
  onData?: (s: string) => void;
  onAbort?: (abort: () => void) => void;
}): Promise<ChatTurnResult> {
  if (!hasCredentials()) {
    const msg = "[chat: SDK lane has no Claude credentials on this machine. Run `claude setup-token` (or `claude login`) and retry.]";
    params.onData?.(msg);
    return { ok: false, text: msg };
  }

  const controller = new AbortController();
  params.onAbort?.(() => controller.abort());

  const server = createSdkMcpServer({ name: "chat", tools: params.tools });
  let text = "";
  let sessionId: string | undefined;
  let usage: { tokens: number; cost: number } | undefined;
  let ok = false;

  const append = (s: string) => {
    if (text.length < OUTPUT_CAP) text += s;
    params.onData?.(s);
  };

  try {
    const response = query({
      prompt: params.userBody,
      options: {
        tools: [], // no built-in tools — read-only operator chat
        mcpServers: { chat: server },
        canUseTool: async (_n, input) => ({ behavior: "allow", updatedInput: input }),
        model: params.model,
        ...(params.resume ? { resume: params.resume } : {}),
        abortController: controller,
      },
    });

    for await (const message of response) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") append(block.text);
        }
      } else if (message.type === "result") {
        ok = message.subtype === "success" && !message.is_error;
        sessionId = message.session_id;
        const u = message.usage;
        const tokens =
          (u?.input_tokens ?? 0) +
          (u?.output_tokens ?? 0) +
          (u?.cache_creation_input_tokens ?? 0) +
          (u?.cache_read_input_tokens ?? 0);
        usage = { tokens, cost: Math.round((message.total_cost_usd ?? 0) * 1e6) };
        if (message.subtype !== "success") {
          append(`\n[chat: sdk result ${message.subtype}]\n`);
        }
      }
    }
  } catch (e) {
    append(`\n[chat: sdk error: ${(e as Error).message}]\n`);
    ok = false;
  }

  return { ok, text, sessionId, usage };
}
