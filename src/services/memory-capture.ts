import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { notes } from "../db/schema.js";
import { saveNote } from "./notes.js";
import { getSetting } from "./settings.js";
import { runChatTurn } from "../chat/agent.js";

// Automatic memory capture (spec 2026-08-22-memory-design). Runs after a chat
// turn or a forge work stage, never awaited by them. Everything here is
// fail-open: an extractor error saves nothing and logs once.

export type Extracted = {
  decisions: { text: string; rationale: string; domain?: string }[];
  rules: { text: string; domain: string }[];
};
export type Extractor = (text: string) => Promise<Extracted | null>;

const MAX_ITEMS = 5;

const EXTRACT_PROMPT = `You extract durable memory from a work transcript. Reply with JSON only, no prose, no code fence:
{"decisions":[{"text":"...","rationale":"...","domain":"..."}],"rules":[{"text":"...","domain":"..."}]}
A decision is a choice that was made and why. A rule is a standing constraint stated as always/never. domain is one lowercase word for the area (e.g. payments, extension, tests). Return empty arrays when there is nothing durable. Never invent.`;

// ponytail: haiku on the SDK lane is the cheapest thing already wired in. A
// CLI or OpenRouter extractor is a later swap behind the same seam.
const defaultExtractor: Extractor = async (text) => {
  const res = await runChatTurn({ userBody: text.slice(0, 12_000), tools: [], model: "haiku", systemPrompt: EXTRACT_PROMPT });
  return res.ok ? parseExtraction(res.text) : null;
};

let extractor: Extractor = defaultExtractor;
export function setMemoryExtractor(fn: Extractor | null): void { extractor = fn ?? defaultExtractor; }

export function parseExtraction(raw: string): Extracted | null {
  const body = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let v: unknown;
  try { v = JSON.parse(body); } catch { return null; }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.decisions) || !Array.isArray(o.rules)) return null;
  const str = (x: unknown) => typeof x === "string" && x.trim() ? x.trim() : null;
  const decisions = o.decisions.flatMap((d: any) => {
    const text = str(d?.text), rationale = str(d?.rationale);
    return text && rationale ? [{ text, rationale, ...(str(d?.domain) ? { domain: str(d.domain)! } : {}) }] : [];
  });
  const rules = o.rules.flatMap((r: any) => {
    const text = str(r?.text), domain = str(r?.domain);
    return text && domain ? [{ text, domain }] : [];
  });
  return { decisions, rules };
}

async function exists(kind: string, scope: string, refId: string | undefined, text: string): Promise<boolean> {
  const rows = await db.select({ id: notes.id }).from(notes).where(and(
    eq(notes.kind, kind), eq(notes.scope, scope as "global" | "project" | "ticket"),
    refId ? eq(notes.refId, refId) : isNull(notes.refId),
    isNull(notes.deletedAt),
    sql`lower(${notes.body}) = ${text.toLowerCase()}`,
  )).limit(1);
  return rows.length > 0;
}

export async function captureMemory(input: { actorId: string; text: string; projectId?: string | null }): Promise<number> {
  try {
    if ((await getSetting("memory.autoCapture")) === "off") return 0;
    const got = await extractor(input.text);
    if (!got) return 0;
    const scope = input.projectId ? "project" : "global";
    const refId = input.projectId ?? undefined;
    const items = [
      ...got.decisions.map((d) => ({ kind: "decision" as const, body: d.text, rationale: d.rationale, domain: d.domain })),
      ...got.rules.map((r) => ({ kind: "rule" as const, body: r.text, rationale: undefined, domain: r.domain })),
    ].slice(0, MAX_ITEMS);
    let saved = 0;
    for (const it of items) {
      if (await exists(it.kind, scope, refId, it.body)) continue;
      await saveNote(input.actorId, { body: it.body, scope, refId, kind: it.kind, domain: it.domain, rationale: it.rationale, source: "auto" });
      saved++;
    }
    return saved;
  } catch (e) {
    console.warn(`memory capture skipped: ${(e as Error).message}`);
    return 0;
  }
}
