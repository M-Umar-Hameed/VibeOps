import { recallBlock } from "../services/recall.js";
import { redactSecrets } from "./redact.js";
import { searchKnowledge } from "../services/knowledge.js";

const KNOWLEDGE_BODY_CHARS = 500;
const KNOWLEDGE_LIMIT = 5;
// Wider pool so session transcripts can be pushed out by docs that score slightly lower.
const KNOWLEDGE_POOL = 10;

export function knowledgeQuery(ticket: { title: string; body?: string | null }): string {
  const body = (ticket.body ?? "").trim().slice(0, KNOWLEDGE_BODY_CHARS);
  return redactSecrets(body ? `${ticket.title}\n${body}` : ticket.title);
}

// Session transcripts rank below notes, vault and repo docs; order within each group is kept.
export function rankForgeKnowledge<T extends { sourceKind: string }>(hits: T[], limit = KNOWLEDGE_LIMIT): T[] {
  return [...hits.filter((h) => h.sourceKind !== "session"), ...hits.filter((h) => h.sourceKind === "session")].slice(0, limit);
}

export async function getKnowledgeSafe(q: string, projectId?: string): Promise<{ content: string; citation: string }[]> {
  try { return rankForgeKnowledge(await searchKnowledge(q, { limit: KNOWLEDGE_POOL, projectId, caller: "forge:run" })); } catch { return []; }
}

export async function getMemorySafe(q: string, projectId?: string | null): Promise<string> {
  try { return await recallBlock(q, { projectId: projectId ?? undefined }); }
  catch (e) { console.warn(`forge: recall failed: ${(e as Error).message}`); return ""; }
}
