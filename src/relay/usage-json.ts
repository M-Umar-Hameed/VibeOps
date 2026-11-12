export type JsonUsage = { text: string; usage: { tokens: number; cost: number } };

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function parseUsageJson(raw: string): JsonUsage | undefined {
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    let j: Record<string, unknown>;
    try { j = JSON.parse(line); } catch { continue; }
    let text: string;
    let tokens: number;
    let cost = 0;
    const u = j.usage as Record<string, unknown> | undefined;
    if (j.type === "result" && u && typeof u === "object") {
      text = typeof j.result === "string" ? j.result : `[claude result: ${typeof j.subtype === "string" ? j.subtype : "error"}]`;
      tokens = n(u.input_tokens) + n(u.output_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
      cost = Math.round(n(j.total_cost_usd) * 1e6);
    } else if (typeof j.response === "string" && u && typeof u === "object" && typeof u.total_tokens === "number") {
      text = j.response;
      tokens = u.total_tokens;
    } else {
      return undefined;
    }
    const prefix = lines.slice(0, i).join("\n").trim();
    return { text: prefix ? prefix + "\n" + text : text, usage: { tokens, cost } };
  }
  return undefined;
}
