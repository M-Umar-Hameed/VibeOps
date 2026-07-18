import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { aiUsageLogs, agentSessions } from "../db/schema.js";

// We keep the fuller entry shape for call-site clarity. Headless CLIs don't report
// real usage, so tokens are estimated. ok is tracked separately via agent_sessions.status.
export type UsageEntry = {
  actorId: string;
  agent: string;
  role: string;
  ticketId?: string;
  outputChars: number;
  durationMs: number;
  ok: boolean;
};

export async function logAgentUse(entry: UsageEntry): Promise<void> {
  try {
    await db.insert(aiUsageLogs).values({
      provider: entry.agent,
      model: entry.role,
      tokens: Math.round(entry.outputChars / 4), // estimated: headless CLIs report no token counts
      ticketId: entry.ticketId,
      actorId: entry.actorId,
      durationMs: entry.durationMs,
    });
  } catch (e) {
    console.warn("logAgentUse failed:", (e as Error).message);
  }
}

// One row per forge stage execution. agent_sessions has no ticketId column, so the
// caller should fold ticket/role context into `agentName` if it wants that visible.
export async function startAgentSession(agentName: string): Promise<string | undefined> {
  try {
    const [row] = await db.insert(agentSessions)
      .values({ agentName, status: "running" })
      .returning({ id: agentSessions.id });
    return row?.id;
  } catch (e) {
    console.warn("startAgentSession failed:", (e as Error).message);
    return undefined;
  }
}

export async function endAgentSession(id: string | undefined, ok: boolean): Promise<void> {
  if (!id) return;
  try {
    await db.update(agentSessions)
      .set({ status: ok ? "passed" : "failed", updatedAt: new Date() })
      .where(eq(agentSessions.id, id));
  } catch (e) {
    console.warn("endAgentSession failed:", (e as Error).message);
  }
}
