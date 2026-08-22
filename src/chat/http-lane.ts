// Chat-only HTTP lane: one turn against an OpenAI-compatible chat/completions
// endpoint (OpenRouter). No tools, no resume - the rolled transcript is the
// whole context, same contract as the CLI lanes.
// ponytail: fetch + hand-rolled SSE split; no openai dep for one endpoint.

export type HttpTurnParams = {
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  transcript: string;
  onData: (s: string) => void;
  timeoutMs?: number;
};

export type HttpTurnResult = { ok: boolean; text: string };

export async function runHttpTurn(p: HttpTurnParams): Promise<HttpTurnResult> {
  const messages: { role: string; content: string }[] = [];
  if (p.system) messages.push({ role: "system", content: p.system });
  messages.push({ role: "user", content: p.transcript });

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
          if (data === "[DONE]") return { ok: true, text };
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
