// Chat-only HTTP lane: one turn against an OpenAI-compatible chat/completions
// endpoint (OpenRouter). No resume - the rolled transcript is the whole
// context, same contract as the CLI lanes. Tool calling (below) is optional:
// omit `tools` for the plain streaming path.
// ponytail: fetch + hand-rolled SSE split; no openai dep for one endpoint.

// Provider-neutral tool the http lane can call; the caller (turns.ts, via
// openai-tools.ts) adapts the SDK chat tools into this shape.
export type ToolDef = {
  name: string;
  description: string;
  parameters: object;
  run: (args: unknown) => Promise<string>;
};

export type HttpTurnParams = {
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  transcript: string;
  onData: (s: string) => void;
  timeoutMs?: number;
  tools?: ToolDef[];
  images?: { mediaType: string; data: string }[];
};

export type HttpTurnResult = { ok: boolean; text: string };

const MAX_TOOL_ROUNDS = 8;

// A blank assistant bubble reads as a hang, not a finished (if silent) turn.
const NO_TEXT_REPLY = "[no text reply from the model; its tool calls are shown above]";
// Streaming path never has tools attached, so nothing was "shown above".
const EMPTY_STREAM_REPLY = "[the model returned an empty reply]";

// Non-streaming request/response loop used only when tools are attached: a
// provider tool call requires a full JSON message (with tool_calls) to build
// the next round's messages array, which SSE deltas don't give us.
async function runToolLoop(p: HttpTurnParams, messages: any[]): Promise<HttpTurnResult> {
  const tools = p.tools!;
  const toolDefs = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  let textSoFar = "";
  let ranToolRound = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    p.onData("[model] thinking...\n"); // every request, so a slow first call is visible too
    let res: Response;
    try {
      res = await fetch(`${p.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify({ model: p.model, stream: false, messages, tools: toolDefs }),
        signal: AbortSignal.timeout(p.timeoutMs ?? 300_000),
      });
    } catch (e) {
      const cause = (e as Error & { cause?: Error }).cause?.message;
      return { ok: false, text: `[chat: request to ${p.baseUrl} failed: ${(e as Error).message}${cause ? ` (${cause})` : ""}]` };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let detail = body;
      try { detail = JSON.parse(body)?.error?.message ?? body; } catch {}
      return { ok: false, text: `[chat: provider returned ${res.status}: ${detail}]` };
    }

    const data = (await res.json()) as any;
    // Some providers answer 200 with an error object and no choices (rate
    // limits, upstream failures). Surface it instead of storing a blank reply.
    if (data?.error && !data?.choices?.length) {
      const detail = typeof data.error === "string" ? data.error : data.error.message ?? JSON.stringify(data.error);
      const text = `[chat: provider returned an error: ${detail}]`;
      p.onData(text);
      return { ok: false, text };
    }
    const msg = data?.choices?.[0]?.message ?? {};
    const toolCalls = msg.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      const text = typeof msg.content === "string" ? msg.content : "";
      // Never store a blank reply: with tool rounds the trace explains it,
      // without them the placeholder says the model sent nothing.
      const final = text || (ranToolRound ? NO_TEXT_REPLY : EMPTY_STREAM_REPLY);
      p.onData(final);
      return { ok: true, text: final };
    }

    ranToolRound = true;
    if (typeof msg.content === "string" && msg.content) textSoFar += msg.content;
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      const name = call.function?.name;
      const tool = tools.find((t) => t.name === name);
      let result: string;
      if (!tool) {
        result = `unknown tool ${name}`;
      } else {
        let args: unknown;
        try {
          args = JSON.parse(call.function?.arguments ?? "{}");
        } catch (e) {
          messages.push({ role: "tool", tool_call_id: call.id ?? "", content: `invalid arguments: ${(e as Error).message}` });
          continue;
        }
        try {
          p.onData(`[${name}] running...\n`);
          result = await tool.run(args);
        } catch (e) {
          result = `tool error: ${(e as Error).message}`;
        }
      }
      // Stream a progress line per call: a tool loop can grind for minutes
      // (browser batches wait up to 45s), and a silent Working pane reads as a
      // hang. The persisted final answer replaces these lines after the turn.
      const summary = result.replace(/\s+/g, " ").slice(0, 120);
      p.onData(`[${call.function?.name ?? "tool"}] ${summary}\n`);
      messages.push({ role: "tool", tool_call_id: call.id ?? "", content: result });
    }
  }

  const capText = textSoFar + "\n[chat: tool loop exceeded 8 rounds]";
  p.onData(capText);
  return { ok: false, text: capText };
}

export async function runHttpTurn(p: HttpTurnParams): Promise<HttpTurnResult> {
  const messages: { role: string; content: any }[] = [];
  if (p.system) messages.push({ role: "system", content: p.system });
  const userContent = p.images?.length
    ? [{ type: "text", text: p.transcript }, ...p.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mediaType};base64,${i.data}` } }))]
    : p.transcript;
  messages.push({ role: "user", content: userContent });

  if (p.tools?.length) return runToolLoop(p, messages);

  let res: Response;
  try {
    res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({ model: p.model, stream: true, messages }),
      signal: AbortSignal.timeout(p.timeoutMs ?? 300_000),
    });
  } catch (e) {
    const cause = (e as Error & { cause?: Error }).cause?.message;
    return { ok: false, text: `[chat: request to ${p.baseUrl} failed: ${(e as Error).message}${cause ? ` (${cause})` : ""}]` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let detail = body;
    try { detail = JSON.parse(body)?.error?.message ?? body; } catch {}
    return { ok: false, text: `[chat: provider returned ${res.status}: ${detail}]` };
  }

  // SSE: frames are "data: <json>\n\n"; a frame can split across reads, so
  // buffer and only consume up to the last complete delimiter.
  let text = "";
  let buf = "";
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") {
            if (!text) { p.onData(EMPTY_STREAM_REPLY); return { ok: true, text: EMPTY_STREAM_REPLY }; }
            return { ok: true, text };
          }
          try {
            const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta) { text += delta; p.onData(delta); }
          } catch {} // comment/keepalive frames are not JSON; skip
        }
      }
    }
  } catch (e) {
    return { ok: false, text: text + `\n[chat: stream broke: ${(e as Error).message}]` };
  }
  // Stream ended without [DONE]: partial answer, marked failed so it is not
  // mistaken for a complete reply.
  return { ok: false, text: text + "\n[chat: stream ended before completion]" };
}
