import type { RelayConfig } from "../relay/config.js";

// Max chars of rolled chat transcript folded into one CLI-lane prompt. CLI lanes
// are one-shot with no streaming resume, so every turn re-sends the history;
// oldest messages drop first once this ceiling is hit.
export const CHAT_TRANSCRIPT_CAP = 24_000;

export type RosterModel = { name: string; toolCapable?: boolean };
export type RosterEntry = { agent: string; toolCapable: boolean; models: RosterModel[] };

// Every relay agent that holds any role, with its models. toolCapable is true for
// the sdk lane and for any CLI lane flagged mcp:true (reaches the shared MCP tools
// via its own MCP client config; see docs/AGENT_CLIS.md). A CLI lane without a
// verified tool mechanism stays false so the picker never over-promises.
export function buildRoster(config: RelayConfig): RosterEntry[] {
  const roster: RosterEntry[] = [];
  for (const [name, agent] of Object.entries(config.agents)) {
    // http lanes are chat-only, so they carry no pipeline roles; roles gate
    // only the process lanes. Their models come from the provider catalog at
    // request time, not relay.json.
    if (agent.type !== "http" && !agent.roles?.length) continue;
    roster.push({
      agent: name,
      toolCapable: agent.type === "sdk" || agent.mcp === true,
      models: (agent.models ?? []).map((m) => ({ name: m.name })),
    });
  }
  return roster;
}

// A session model is 'agent::model'. Legacy rows ('sonnet'/'opus') have no '::'
// and map to the sdk lane, so agent is null and the bare string is the model.
export function parseModelRef(model: string): { agent: string | null; model: string } {
  const i = model.indexOf("::");
  if (i === -1) return { agent: null, model };
  return { agent: model.slice(0, i), model: model.slice(i + 2) };
}

// Newest-first fill up to `cap`, dropping the oldest messages when over. The
// newest message always survives even if it alone exceeds the cap.
export function rollTranscript(
  msgs: { role: string; body: string }[],
  cap = CHAT_TRANSCRIPT_CAP,
): string {
  const lines = msgs.map((m) => `${m.role}: ${m.body}`);
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const add = lines[i].length + (kept.length ? 2 : 0); // 2 = "\n\n" separator
    if (size + add > cap && kept.length) break;
    kept.unshift(lines[i]);
    size += add;
  }
  return kept.join("\n\n");
}
