import { realpathSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { embeddings, projects } from "../../db/schema.js";
import { sandboxRoot } from "../../forge/sandbox.js";
import { getSetting, setSetting } from "../../services/settings.js";
import { conversationDirOf } from "./antigravity.js";
import { readHead } from "./tail.js";
import { backfillSessionKnowledge, ticketProjectFromDb } from "./session-project.js";

export type AgResolverInput = {
  projects: { id: string; repoPath: string | null }[];
  ticketProject: (ticketId: string) => Promise<string | null>;
  sandboxDir: string;
  readText: (convDir: string) => string; // "" when no transcript
  realpath?: (p: string) => string | null;
};

// Escaped/plain backslashes, file:// URIs, %3a and case all collapse to lowercase forward-slash paths.
export function normalizeForMatch(s: string): string {
  return s
    .replace(/\\\\/g, "/")
    .replace(/\\/g, "/")
    .replace(/file:\/\/\/(?=[a-z]:)/gi, "")
    .replace(/file:\/\//gi, "")
    .replace(/%3a/gi, ":")
    .replace(/\/{2,}/g, "/")
    .toLowerCase();
}

const normPath = (p: string): string => normalizeForMatch(p).replace(/\/+$/, "");
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PATH_TOKEN = /(?<![\w.:\/])(?:[a-z]:)?\/[^\s"'<>|*?`()\[\]{},;]+/g;

export async function attributeConversation(text: string, input: AgResolverInput): Promise<string | null> {
  if (!text) return null;
  const n = normalizeForMatch(text);
  const sb = normPath(input.sandboxDir);

  // 1. Forge worker: sandbox/<ticket-uuid> paths, most-mentioned uuid that is a ticket.
  const uuids = new Map<string, number>();
  for (const m of n.matchAll(new RegExp(escapeRe(sb) + "/(?:views/)?(" + UUID + ")", "g"))) {
    uuids.set(m[1], (uuids.get(m[1]) ?? 0) + 1);
  }
  for (const [uuid] of [...uuids].sort((a, b) => b[1] - a[1])) {
    const pid = await input.ticketProject(uuid);
    if (pid) return pid;
  }

  // 2. Tally path mentions per registered project (longest repoPath wins per mention).
  const realpath = input.realpath ?? ((p: string) => {
    try { return realpathSync.native(p); } catch { return null; }
  });
  const projs = input.projects
    .filter((p) => p.repoPath)
    .map((p) => {
      const rp = normPath(p.repoPath!);
      const real = realpath(p.repoPath!);
      const realN = real ? normPath(real) : null;
      return { id: p.id, repo: p.repoPath!, rp, realN, paths: realN && realN !== rp ? [rp, realN] : [rp] };
    });
  const aliasCache = new Map<string, string | null>();
  const aliasFor = (p: (typeof projs)[number], drive: string): string | null => {
    const key = p.id + "|" + drive;
    if (aliasCache.has(key)) return aliasCache.get(key)!;
    let res: string | null = null;
    const repoDrive = p.repo.match(/^([A-Za-z]):/);
    if (repoDrive && repoDrive[1].toLowerCase() !== drive) {
      const alt = drive + p.repo.slice(1);
      const altReal = realpath(alt);
      if (altReal && p.realN && normPath(altReal) === p.realN) res = normPath(alt);
    }
    aliasCache.set(key, res);
    return res;
  };

  const counts = new Map<string, number>();
  let total = 0;
  for (const m of n.matchAll(PATH_TOKEN)) {
    const tok = m[0].replace(/[.:]+$/, "");
    if (tok === sb || tok.startsWith(sb + "/")) continue;
    const drive = /^([a-z]):/.exec(tok)?.[1];
    let best: { id: string; len: number } | null = null;
    for (const p of projs) {
      const alias = drive ? aliasFor(p, drive) : null;
      for (const c of alias ? [...p.paths, alias] : p.paths) {
        if ((tok === c || tok.startsWith(c + "/")) && (!best || c.length > best.len)) best = { id: p.id, len: c.length };
      }
    }
    if (best) {
      counts.set(best.id, (counts.get(best.id) ?? 0) + 1);
      total++;
    }
  }
  if (!total) return null;

  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const [winner, wc] = ranked[0];
  if (ranked[1] && ranked[1][1] === wc) return null;
  if (wc < 2 || wc / total < 0.6) return null;

  // An ancestor project (admin = C:\Users\Admin, which also holds ~/.vibeops/sandbox) wins only when no
  // other project is mentioned.
  const w = projs.find((p) => p.id === winner)!;
  const isAncestor = sb.startsWith(w.rp + "/") || projs.some((o) => o.id !== w.id && o.rp.startsWith(w.rp + "/"));
  if (isAncestor && ranked.length > 1) return null;
  return winner;
}

export function buildAntigravityProjectResolver(input: AgResolverInput): (convDir: string) => Promise<string | null> {
  const cache = new Map<string, Promise<string | null>>();
  return (convDir) => {
    const key = convDir.toLowerCase();
    let p = cache.get(key);
    if (!p) cache.set(key, p = attributeConversation(input.readText(convDir), input));
    return p;
  };
}

// First 400 KB of the conversation transcript ("" when missing).
export function transcriptHead(convDir: string): string {
  return readHead(join(convDir, ".system_generated", "logs", "transcript.jsonl"), 409_600);
}

export async function loadAntigravityProjectResolver(sandboxDir = sandboxRoot()): Promise<(convDir: string) => Promise<string | null>> {
  const projs = await db.select({ id: projects.id, repoPath: projects.repoPath })
    .from(projects)
    .where(isNotNull(projects.repoPath));
  return buildAntigravityProjectResolver({ projects: projs, ticketProject: ticketProjectFromDb, sandboxDir, readText: transcriptHead });
}

const AG_BRAIN = /[\\/]\.gemini[\\/][^\\/]+[\\/]brain[\\/]/i;

export async function backfillAntigravityKnowledge(opts: {
  resolve?: (convDir: string) => Promise<string | null>;
} = {}): Promise<{ scanned: number; conversations: number; assigned: number; assignedConversations: number }> {
  const resolve = opts.resolve ?? await loadAntigravityProjectResolver();
  const rows = await db.selectDistinct({ ref: embeddings.sourceRef })
    .from(embeddings)
    .where(and(eq(embeddings.sourceKind, "session"), isNull(embeddings.projectId)));

  const byConv = new Map<string, string[]>();
  let scanned = 0;
  for (const { ref } of rows) {
    const conv = AG_BRAIN.test(ref) ? conversationDirOf(ref) : null;
    if (!conv) continue;
    scanned++;
    if (!byConv.has(conv)) byConv.set(conv, []);
    byConv.get(conv)!.push(ref);
  }

  const toAssign = new Map<string, { conv: string; ref: string }[]>();
  for (const [conv, refs] of byConv) {
    const pid = await resolve(conv);
    if (!pid) continue;
    if (!toAssign.has(pid)) toAssign.set(pid, []);
    for (const ref of refs) toAssign.get(pid)!.push({ conv, ref });
  }

  let assigned = 0;
  const assignedConvs = new Set<string>();
  for (const [pid, items] of toAssign) {
    const convOf = new Map(items.map((i) => [i.ref, i.conv]));
    for (let i = 0; i < items.length; i += 500) {
      const slice = items.slice(i, i + 500).map((x) => x.ref);
      const upd = await db.update(embeddings)
        .set({ projectId: pid })
        .where(and(eq(embeddings.sourceKind, "session"), inArray(embeddings.sourceRef, slice), isNull(embeddings.projectId)))
        .returning({ ref: embeddings.sourceRef });
      for (const r of new Set(upd.map((u) => u.ref))) {
        assigned++;
        assignedConvs.add(convOf.get(r)!);
      }
    }
  }
  return { scanned, conversations: byConv.size, assigned, assignedConversations: assignedConvs.size };
}

// One-time step: Antigravity refs, then Claude Code sessions ingested before their project was registered.
export async function backfillAntigravityKnowledgeOnce(): Promise<void> {
  if (await getSetting("knowledge.antigravityBackfill") === "v1") return;
  const antigravity = await backfillAntigravityKnowledge();
  const claudeCode = await backfillSessionKnowledge();
  console.log("antigravity backfill: " + JSON.stringify({ antigravity, claudeCode }));
  await setSetting("knowledge.antigravityBackfill", "v1");
}
