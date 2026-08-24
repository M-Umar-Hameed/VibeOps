import type { RelayAgent } from "./config.js";
import { getSetting } from "../services/settings.js";

// Text-only stages on an OpenAI-compatible lane. No tools, no streaming: one
// completion, the whole prompt as the user message. The work stage never
// routes here (config refuses the role).
export async function runHttpAgent(
  agent: RelayAgent, prompt: string, model: string, onData?: (s: string) => void,
): Promise<{ ok: boolean; output: string }> {
  const key = agent.keySetting ? await getSetting(agent.keySetting) : null;
  if (!key) return { ok: false, output: `[forge: no API key saved for ${agent.keySetting}]` };

  let res: Response;
  try {
    res = await fetch(`${agent.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(agent.timeoutMs ?? 600_000),
    });
  } catch (e) {
    const cause = (e as Error & { cause?: Error }).cause?.message;
    return { ok: false, output: `[forge: request to ${agent.baseUrl} failed: ${(e as Error).message}${cause ? ` (${cause})` : ""}]` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let detail = body;
    try { detail = JSON.parse(body)?.error?.message ?? body; } catch {}
    return { ok: false, output: `[forge: provider returned ${res.status}: ${detail}]` };
  }

  const data = (await res.json()) as any;
  const text = typeof data?.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content : "";
  onData?.(text);
  return { ok: true, output: text };
}
