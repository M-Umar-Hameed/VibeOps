import { getTicket } from "./history.js";
import { listComments } from "./comments.js";
import { getCouncil } from "../council/runs.js";
import { getNote } from "./notes.js";
import { redactSecrets } from "../forge/redact.js";
import { NotFoundError, ConflictError } from "./errors.js";
import { listActors } from "./actors.js";
import { db } from "../db/client.js";
import { embeddings, projects, notes } from "../db/schema.js";
import { and, eq, like, asc, isNull } from "drizzle-orm";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { vibeopsHome } from "../runtime/home.js";

export const MAX_BRIEF_CHARS = 200_000;

// Greedy packer: a section is never split or dropped. A section larger than
// `cap` gets a part of its own (indexed repo docs are <= 200 KB, so such a
// part overshoots the cap only slightly).
export function packSections(sections: string[], cap: number, headerLen: number): string[][] {
  const parts: string[][] = [];
  let cur: string[] = [];
  let len = headerLen;
  for (const s of sections) {
    if (cur.length > 0 && len + s.length > cap) { parts.push(cur); cur = []; len = headerLen; }
    cur.push(s);
    len += s.length;
  }
  if (cur.length > 0) parts.push(cur);
  return parts;
}

export async function buildBrief(kind: "ticket" | "council" | "note" | "project", id: string): Promise<{ filename: string; markdown: string }> {
  const { filename, parts } = await buildBriefParts(kind, id);
  return { filename, markdown: parts[0] };
}

export async function buildBriefParts(kind: "ticket" | "council" | "note" | "project", id: string): Promise<{ filename: string; parts: string[] }> {
  let markdown = "";
  let filename = "";

  if (kind === "ticket") {
    const ticket = await getTicket(id);
    const comments = await listComments(id);
    const actors = await listActors();
    const actorMap = new Map(actors.map(a => [a.id, a.name]));

    markdown = `# ${ticket.title}\n\n**Status:** ${ticket.status}\n\n## Body\n${ticket.body}\n`;
    if (comments.length > 0) {
      markdown += `\n## Comments\n`;
      for (const comment of comments) {
        const authorName = actorMap.get(comment.authorId) || "Unknown";
        markdown += `\n### ${authorName} (${comment.kind})\n${comment.body}\n`;
      }
    }
    filename = `ticket-${id.slice(0, 8)}.md`;
  } else if (kind === "council") {
    const council = getCouncil(id);
    markdown = `# Council Run\n\n## Prompt\n${council.prompt}\n`;
    if (council.believer) markdown += `\n## Believer\n${council.believer}\n`;
    if (council.investor) markdown += `\n## Investor\n${council.investor}\n`;
    if (council.skeptic) markdown += `\n## Skeptic\n${council.skeptic}\n`;
    
    // ponytail: full council session type ceiling
    const c = council as any;
    if (c.spec || (c.questions && c.questions.length > 0) || c.decision) {
      markdown += `\n## Chairman Verdict\n`;
      if (c.decision) markdown += `**Decision:** ${c.decision}\n`;
      if (c.rating !== undefined) markdown += `**Rating:** ${c.rating}/10\n`;
      if (c.spec) markdown += `\n### Spec\n${c.spec}\n`;
      if (c.questions && c.questions.length > 0) {
        markdown += `\n### Questions\n${c.questions.map((q: string) => `- ${q}`).join("\n")}\n`;
      }
    }
    filename = `council-${id.slice(0, 8)}.md`;
  } else if (kind === "note") {
    const note = await getNote(id);
    markdown = `# ${note.title || "Note"}\n\n${note.body}\n`;
    filename = `note-${id.slice(0, 8)}.md`;
  } else if (kind === "project") {
    const [p] = await db.select({ name: projects.name, repoPath: projects.repoPath })
      .from(projects).where(eq(projects.id, id));
    if (!p) throw new NotFoundError(`project not found: ${id}`);

    const chunks = await db.select({ ref: embeddings.sourceRef, content: embeddings.content })
      .from(embeddings)
      .where(and(eq(embeddings.sourceKind, "repo"), like(embeddings.sourceRef, `${id}:%`)))
      .orderBy(asc(embeddings.sourceRef), asc(embeddings.chunkIndex));
    if (chunks.length === 0) {
      throw new ConflictError(`project has no indexed repo docs — run "Index docs" in the workspace first`);
    }

    const docs = new Map<string, string[]>();
    for (const ch of chunks) {
      const arr = docs.get(ch.ref) ?? [];
      arr.push(ch.content);
      docs.set(ch.ref, arr);
    }

    // No limit: listNotes caps at 50 and would silently drop notes.
    const projectNotes = await db.select().from(notes)
      .where(and(eq(notes.scope, "project"), eq(notes.refId, id), isNull(notes.deletedAt)))
      .orderBy(asc(notes.createdAt));
    const rank: Record<string, number> = { rule: 0, decision: 1, note: 2 };
    const labels: Record<string, string> = { rule: "Rule", decision: "Decision" };
    const curated = projectNotes.filter((n) => n.source !== "auto")
      .sort((a, b) => (rank[a.kind] ?? 3) - (rank[b.kind] ?? 3));
    const auto = projectNotes.filter((n) => n.source === "auto");

    const sections: string[] = [];
    for (const n of curated) {
      sections.push(`\n---\n\n## ${labels[n.kind] ?? "Note"}: ${n.title || "Untitled"}\n\n${n.body}\n${n.rationale ? `\nRationale: ${n.rationale}\n` : ""}`);
    }
    for (const [ref, contents] of docs) {
      sections.push(`\n---\n\n## ${ref.slice(id.length + 1)}\n\n${contents.join("\n\n")}\n`);
    }
    if (auto.length > 0) {
      sections.push(`\n---\n\n## Auto-captured notes (${auto.length})\n\n${auto.map((n) => "- " + (n.title || n.body).replace(/\s+/g, " ").trim()).join("\n")}\n`);
    }

    const repo = p.repoPath ?? "(default workdir)";
    const generated = new Date().toISOString();
    const header = (i: number, n: number) => n === 1
      ? `# ${p.name} — Repo Knowledge Brief\n\n**Repo:** ${repo}\n**Generated:** ${generated}\n`
      : `# ${p.name} - Repo Knowledge Brief (part ${i} of ${n})\n\n**Repo:** ${repo}\n**Generated:** ${generated}\n`;
    // Worst-case header length, so the cap holds once the real header is in.
    const packed = packSections(sections, MAX_BRIEF_CHARS, header(sections.length, sections.length).length);
    return {
      filename: `project-${id.slice(0, 8)}.md`,
      parts: packed.map((secs, i) => redactSecrets(header(i + 1, packed.length) + secs.join(""))),
    };
  } else {
    throw new NotFoundError(`kind ${kind}`);
  }

  return { filename, parts: [redactSecrets(markdown)] };
}

export async function writeBriefFiles(projectId: string): Promise<{ dir: string; parts: number; files: { name: string; chars: number }[] }> {
  const [p] = await db.select({ key: projects.key }).from(projects).where(eq(projects.id, projectId));
  if (!p) throw new NotFoundError(`project not found: ${projectId}`);
  const { parts } = await buildBriefParts("project", projectId);

  const safe = p.key.replace(/[^A-Za-z0-9._-]/g, "_");
  const seg = /^\.*$/.test(safe) ? `project-${projectId.slice(0, 8)}` : safe;
  const base = join(vibeopsHome(), ".vibeops", "exports", "notebooklm");
  const dir = join(base, seg);
  if (!resolve(dir).startsWith(resolve(base) + sep)) throw new Error("bad export dir");

  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (/^part-.*\.md$/.test(f)) unlinkSync(join(dir, f));
  const files = parts.map((part, i) => {
    const name = `part-${String(i + 1).padStart(2, "0")}.md`;
    writeFileSync(join(dir, name), part, "utf8");
    return { name, chars: part.length };
  });
  return { dir: resolve(dir), parts: parts.length, files };
}
