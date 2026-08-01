import { getTicket } from "./history.js";
import { listComments } from "./comments.js";
import { getCouncil } from "../council/runs.js";
import { getNote } from "./notes.js";
import { redactSecrets } from "../forge/redact.js";
import { NotFoundError, ConflictError } from "./errors.js";
import { listActors } from "./actors.js";
import { db } from "../db/client.js";
import { embeddings, projects } from "../db/schema.js";
import { and, eq, like, asc } from "drizzle-orm";
import { listNotes } from "./notes.js";

export const MAX_BRIEF_CHARS = 200_000;

export async function buildBrief(kind: "ticket" | "council" | "note" | "project", id: string): Promise<{ filename: string; markdown: string }> {
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

    const projectNotes = await listNotes({ scope: "project", refId: id });

    const sections: string[] = [];
    for (const [ref, contents] of docs) {
      sections.push(`\n---\n\n## ${ref.slice(id.length + 1)}\n\n${contents.join("\n\n")}\n`);
    }
    for (const n of projectNotes) {
      sections.push(`\n---\n\n## Note: ${n.title || "Untitled"}\n\n${n.body}\n`);
    }

    let assembled = `# ${p.name} — Repo Knowledge Brief\n\n**Repo:** ${p.repoPath ?? "(default workdir)"}\n**Generated:** ${new Date().toISOString()}\n`;
    let truncated = false;
    for (const s of sections) {
      if (assembled.length + s.length > MAX_BRIEF_CHARS) { truncated = true; break; }
      assembled += s;
    }
    if (truncated) {
      assembled += `\n\n---\n\n_Content truncated: brief exceeded ${MAX_BRIEF_CHARS} characters; some sources omitted._\n`;
    }
    markdown = assembled;
    filename = `project-${id.slice(0, 8)}.md`;
  } else {
    throw new NotFoundError(`kind ${kind}`);
  }

  return {
    filename,
    markdown: redactSecrets(markdown)
  };
}
