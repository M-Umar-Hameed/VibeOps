import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { notes, projects, type Note } from "../db/schema.js";
import { searchKnowledge } from "./knowledge.js";
import { getEmbedder, type Embedder } from "../knowledge/embedder.js";

// Speak-first memory (spec 2026-08-22-memory-design). Rules fire by exact
// domain match, never similarity; decisions and knowledge come from the
// embedding index. One block, fenced as untrusted by every caller.

export type KnowledgeHit = Awaited<ReturnType<typeof searchKnowledge>>[number];
export type Recall = { rules: Note[]; decisions: Note[]; knowledge: KnowledgeHit[]; domains: string[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RULES = 10;
const MAX_DECISIONS = 5;
const MAX_KNOWLEDGE = 5;
export const RECALL_MAX_CHARS = 2400;

// Twin of projects.ts's kebab() — not imported to avoid dragging the db
// into recall.ts for one string helper.
function kebab(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// The project name is a domain by default so project-scoped rules with a
// matching domain fire without anyone tagging the prompt; #tokens opt in more.
// Multi-word names ("Payments App") also emit a kebab slug, since no
// one-word rule domain would ever match the raw lowercased phrase.
export function domainsFor(query: string, projectName?: string | null): string[] {
  const out: string[] = [];
  if (projectName) {
    const raw = projectName.trim().toLowerCase();
    out.push(raw);
    const slug = kebab(projectName);
    if (slug && slug !== raw) out.push(slug);
  }
  for (const m of query.matchAll(/#([a-z0-9][a-z0-9_-]*)/gi)) {
    const d = m[1].toLowerCase();
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

async function projectName(projectId?: string | null): Promise<string | null> {
  if (!projectId) return null;
  const [p] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).limit(1);
  return p?.name ?? null;
}

export async function recall(
  query: string,
  opts: { projectId?: string | null; domains?: string[]; limit?: number } = {},
  embedder: Embedder = getEmbedder(),
): Promise<Recall> {
  const domains = opts.domains ?? domainsFor(query, await projectName(opts.projectId));
  const scope = opts.projectId
    ? or(eq(notes.scope, "global"), and(eq(notes.scope, "project"), eq(notes.refId, opts.projectId)))
    : eq(notes.scope, "global");
  const domainMatch = domains.length ? or(isNull(notes.domain), inArray(notes.domain, domains)) : isNull(notes.domain);
  const rules = await db.select().from(notes)
    .where(and(eq(notes.kind, "rule"), eq(notes.source, "manual"), isNull(notes.deletedAt), scope, domainMatch))
    .orderBy(desc(notes.createdAt)).limit(MAX_RULES);

  const hits = await searchKnowledge(query, { limit: opts.limit ?? 10, projectId: opts.projectId ?? undefined, caller: "recall" }, embedder);
  // Note-kind hits may carry non-uuid refs (other indexers use "note" with
  // their own ref scheme); only real note ids can be joined back to notes.
  const noteIds = hits.filter((h) => h.sourceKind === "note" && UUID_RE.test(h.sourceRef)).map((h) => h.sourceRef);
  const typed = noteIds.length
    ? await db.select().from(notes).where(and(inArray(notes.id, noteIds), isNull(notes.deletedAt)))
    : [];
  const byId = new Map(typed.map((n) => [n.id, n]));
  const { decisions, knowledge } = partitionHits(hits, byId);
  return { rules, decisions, knowledge, domains };
}

// A note that was chunked into multiple embeddings can surface as several
// hits sharing one sourceRef; dedupe on note id so a chunked decision is
// never pushed twice. Pure and exported so the dedup is testable without a
// live embedder.
export function partitionHits(
  hits: KnowledgeHit[],
  byId: Map<string, Note>,
): { decisions: Note[]; knowledge: KnowledgeHit[] } {
  const decisions: Note[] = [];
  const knowledge: KnowledgeHit[] = [];
  const seenDecisionIds = new Set<string>();
  for (const h of hits) {
    const n = h.sourceKind === "note" ? byId.get(h.sourceRef) : undefined;
    if (n?.kind === "decision") {
      if (seenDecisionIds.has(h.sourceRef)) continue;
      seenDecisionIds.add(h.sourceRef);
      if (decisions.length < MAX_DECISIONS) decisions.push(n);
      continue;
    }
    if (n?.kind === "rule") continue; // rules fire by domain above, never by similarity
    if (knowledge.length < MAX_KNOWLEDGE) knowledge.push(h);
  }
  return { decisions, knowledge };
}

function line(prefix: string, body: string): string {
  return `- [${prefix}] ${body.replace(/\r?\n/g, " ").trim()}`;
}

// Rules are never cut; knowledge is cut first, then decisions, until the block
// fits. A truncated rule would be a wrong rule: once knowledge and decisions
// are both exhausted, an over-long rules section is returned whole, uncut,
// even past maxChars.
export function formatRecall(r: Recall, maxChars = RECALL_MAX_CHARS): string {
  if (!r.rules.length && !r.decisions.length && !r.knowledge.length) return "";
  const head = `Memory (rules fire for: ${r.domains.length ? r.domains.join(", ") : "global only"}):`;
  const rules = r.rules.map((n) => line(n.domain ?? "global", n.body));
  const decisions = r.decisions.map((n) => line(n.domain ?? "global", n.rationale ? `${n.body}. Rationale: ${n.rationale}` : n.body));
  const knowledge = r.knowledge.map((h) => line(`${h.sourceKind} ${h.score.toFixed(2)} ${h.createdAt.slice(0, 10)}`, h.content.slice(0, 400)));
  const render = (d: string[], k: string[]) => [
    head,
    rules.length ? ["Rules:", ...rules].join("\n") : "",
    d.length ? ["Decisions:", ...d].join("\n") : "",
    k.length ? ["Knowledge:", ...k].join("\n") : "",
  ].filter(Boolean).join("\n");
  let d = decisions, k = knowledge;
  let out = render(d, k);
  while (out.length > maxChars && k.length) { k = k.slice(0, -1); out = render(d, k); }
  while (out.length > maxChars && d.length) { d = d.slice(0, -1); out = render(d, k); }
  if (out === head) return ""; // the cap dropped every section: no bare header
  return out;
}

export async function recallBlock(
  query: string,
  opts: { projectId?: string | null; domains?: string[]; limit?: number; maxChars?: number } = {},
  embedder: Embedder = getEmbedder(),
): Promise<string> {
  return formatRecall(await recall(query, opts, embedder), opts.maxChars);
}
