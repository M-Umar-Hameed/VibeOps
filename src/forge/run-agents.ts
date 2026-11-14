import { type Stage, type Run, append } from "./run-state.js";
import { type RelayConfig, type RelayAgent } from "../relay/config.js";
import { type AgentResult } from "../relay/invoke.js";
import { type Pick } from "./router.js";
import { logAgentUse, startAgentSession, endAgentSession } from "../services/usage.js";
import { verifyModel, MISMATCH_WARNING } from "./verify.js";
import { getSetting } from "../services/settings.js";
import { sum, eq, gte } from "drizzle-orm";
import { db } from "../db/client.js";
import { aiUsageLogs } from "../db/schema.js";

// Wraps a stage's runAgent call with an agent_sessions row (start/end) and an
// ai_usage_logs row. Lanes that report real usage supply it; the rest fall back to
// an estimate over prompt+output, so promptChars has to reach logAgentUse.
// Never throws.
export async function track(
  actorId: string, ticketId: string, role: Stage, agentName: string,
  promptChars: number,
  fn: () => Promise<AgentResult>,
): Promise<AgentResult> {
  const sessionId = await startAgentSession(`${role}:${agentName}`);
  const startedAt = Date.now();
  const res = await fn();
  await endAgentSession(sessionId, res.ok);
  await logAgentUse({
    actorId, agent: agentName, role, ticketId,
    promptChars, outputChars: res.output.length, durationMs: Date.now() - startedAt, ok: res.ok,
    tokens: res.usage?.tokens, cost: res.usage?.cost,
  });
  return res;
}

// Records which subscription account a stage ran on (lanes with relay.json accounts only).
export function noteAccount(run: Run, role: "plan" | "work" | "review", res: AgentResult): AgentResult {
  if (res.account) run.accounts = { ...run.accounts, [role]: res.account };
  if (res.account && res.limit) run.limit = { role, account: res.account };
  return res;
}

export function getAgent(config: RelayConfig, name: string, role: Stage): RelayAgent {
  const a = config.agents[name];
  if (!a) throw new Error(`relay config has no agent "${name}"`);
  if (!a.roles.includes(role)) throw new Error(`agent "${name}" is not configured for role "${role}"`);
  return a;
}

// "agent:model" when a model was chosen, plain agent name otherwise -- this
// composite is what's stored in run.agents / forge_runs (no schema change).
export function composite(pick: Pick): string {
  return pick.model ? `${pick.agent}:${pick.model}` : pick.agent;
}

// Inverse of composite(): the model half, or undefined for a bare agent name.
// Only the sdk/http lanes need this; cli agents get the model via resolveCmd.
// Split on the FIRST colon only -- an OpenRouter id like
// "meta-llama/llama-3.1-8b-instruct:free" has a colon of its own, and
// split(":")[1] would truncate it, silently requesting a different model.
export function modelOf(composited: string): string | undefined {
  const i = composited.indexOf(":");
  return i === -1 ? undefined : composited.slice(i + 1);
}

// "agent:model" (or bare "agent") from a forge.defaultModel.<role> setting.
// ponytail: split on the first ":" — agent/model names carry no colons today.
export function parsePair(value: string): Pick {
  const i = value.indexOf(":");
  return i === -1 ? { agent: value } : { agent: value.slice(0, i), model: value.slice(i + 1) || undefined };
}

export function applyVerification(res: { ok: boolean; output: string }, compositeName: string, run: Run, config: RelayConfig): void {
  // parsePair splits on the first colon only -- a colon-suffixed model id
  // (e.g. an OpenRouter "a/b:free" id) must reach verifyModel intact, not
  // truncated at its own colon.
  const { agent: agentName, model: requestedModel } = parsePair(compositeName);
  // Match on the actual BINARY, not the relay.json key — users key agents
  // freely ("fable", "agy-gemini"), the CLI's output format follows the exe.
  // sdk agents legitimately carry no cmd (config validation skips it for them),
  // and an empty array would slip past ?? and crash on cmd[0]. Length-check it.
  const configured = config.agents[agentName]?.cmd;
  const cmd = configured?.length ? configured : [agentName];
  const strip = (p0: string) => (p0.replace(/\\/g, "/").split("/").pop() ?? p0).replace(/\.(exe|cmd|bat|mjs|cjs|js|py)$/i, "");
  // Generic interpreters carry no identity — the script they run does.
  const INTERPRETERS = new Set(["node", "python", "python3", "deno", "bun"]);
  const first = strip(cmd[0]);
  const binary = INTERPRETERS.has(first.toLowerCase()) && cmd[1] ? strip(cmd[1]) : first;
  const status = verifyModel(binary, requestedModel, res.output);
  if (status !== "unknown") {
    const marker = `\n\n[forge: verification=${status}]`;
    res.output += marker;
    append(run, marker);
    if (status === "mismatch") {
      res.output += `\n${MISMATCH_WARNING}`;
      append(run, `\n${MISMATCH_WARNING}`);
    }
  }
}

// capsOverride exists for tests: the per-day cap is inherently global, and a
// test persisting it in the shared settings DB throttles every parallel
// pipeline in the suite (live-hit).
export async function checkBudget(
  ticketId: string,
  capsOverride?: { perTicket?: number; perDay?: number },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const perTicketSetting = capsOverride ? String(capsOverride.perTicket ?? "") : (await getSetting("ai.budget.perTicketTokens"));
  const perDaySetting = capsOverride ? String(capsOverride.perDay ?? "") : (await getSetting("ai.budget.perDayTokens"));

  const perTicketCap = parseInt(perTicketSetting || "", 10);
  const perDayCap = parseInt(perDaySetting || "", 10);

  if (!isNaN(perTicketCap)) {
    const [row] = await db.select({ total: sum(aiUsageLogs.tokens) }).from(aiUsageLogs).where(eq(aiUsageLogs.ticketId, ticketId));
    const total = Number(row?.total || 0);
    if (total > perTicketCap) {
      return { ok: false, reason: `per-ticket token cap exceeded: ${total} > ${perTicketCap}` };
    }
  }

  if (!isNaN(perDayCap)) {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const [row] = await db.select({ total: sum(aiUsageLogs.tokens) }).from(aiUsageLogs).where(gte(aiUsageLogs.createdAt, startOfDay));
    const total = Number(row?.total || 0);
    if (total > perDayCap) {
      return { ok: false, reason: `per-day token cap exceeded: ${total} > ${perDayCap}` };
    }
  }

  return { ok: true };
}
