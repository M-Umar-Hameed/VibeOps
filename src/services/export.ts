import { getTicket } from "./history.js";
import { listComments } from "./comments.js";
import { getCouncil } from "../council/runs.js";
import { getNote } from "./notes.js";
import { redactSecrets } from "../forge/redact.js";
import { NotFoundError } from "./errors.js";
import { listActors } from "./actors.js";

export async function buildBrief(kind: "ticket" | "council" | "note", id: string): Promise<{ filename: string; markdown: string }> {
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
  } else {
    throw new NotFoundError(`kind ${kind}`);
  }

  return {
    filename,
    markdown: redactSecrets(markdown)
  };
}
