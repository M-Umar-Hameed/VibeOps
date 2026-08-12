import { addComment } from "./comments.js";
import { saveNote } from "./notes.js";
import { searchKnowledge } from "./knowledge.js";

export type ArtifactBlock = {
  artifact: string;
  id: string;
  trigger?: string;
  table?: string;
  target?: string;
  channel?: string;
  mapping?: string;
  path?: "api" | "browser" | "none";
  pathReason?: string;
  action?: string;
};

// Extract the first fenced ```json block from free text and validate the two
// fields an objection can never fire without (epic A: id required, artifact typed).
// Returns null on any failure — silence beats a false alarm.
export function parseArtifactBlock(text: string): ArtifactBlock | null {
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (!m) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const b = obj as Record<string, unknown>;
  if (typeof b.artifact !== "string" || typeof b.id !== "string" || b.id === "") return null;
  return b as ArtifactBlock;
}

export function formatArtifactBlock(block: ArtifactBlock): string {
  return "```json\n" + JSON.stringify(block, null, 2) + "\n```";
}

const RESOURCE_FIELDS = ["table", "target", "channel", "mapping"] as const;

// Mechanical objection gate — NOT a semantic judgement (ticket: never a hunch).
// Fires only when a concrete artifact can be cited:
//   candidate.id present, trigger exact-match, and >=1 resource field exact-match.
// Returns the matched field names (for the evidence message) or null (stay silent).
export function confirmObjection(request: ArtifactBlock, candidate: ArtifactBlock): string[] | null {
  if (!candidate.id) return null;
  if (!request.trigger || !candidate.trigger) return null;
  if (request.trigger !== candidate.trigger) return null;
  const matched = RESOURCE_FIELDS.filter((f) => request[f] != null && request[f] === candidate[f]);
  if (matched.length === 0) return null;
  return ["trigger", ...matched];
}

function queryFor(request: ArtifactBlock): string {
  return [request.artifact, request.trigger, request.table, request.target, request.channel, request.mapping]
    .filter(Boolean)
    .join(" ");
}

function evidenceBody(request: ArtifactBlock, candidate: ArtifactBlock, matched: string[]): string {
  const resources = matched
    .filter((f) => f !== "trigger")
    .map((f) => `same ${f} \`${(candidate as Record<string, unknown>)[f]}\``)
    .join(", ");
  return `This exists — ${candidate.artifact} ${candidate.id}, same trigger \`${candidate.trigger}\`, ${resources}. ` +
    `Extend ${candidate.id} instead of a second ${candidate.artifact} that double-fires.`;
}

export type PreflightResult =
  | { objection: null }
  | { objection: { candidateId: string; matched: string[]; body: string; commentId: string } };

// Runs BEFORE any mutation. Never blocks. If a duplicate is confirmed, writes an
// `evidence` comment citing the artifact and returns it; caller shows it, human decides.
export async function preflightDuplicateCheck(
  request: ArtifactBlock,
  ctx: { ticketId: string; projectId: string; actorId: string },
  deps: {
    search?: typeof searchKnowledge;
    add?: typeof addComment;
  } = {},
): Promise<PreflightResult> {
  const search = deps.search ?? searchKnowledge;
  const add = deps.add ?? addComment;
  const hits = await search(queryFor(request), { projectId: ctx.projectId, caller: "preflight", limit: 5 });
  for (const hit of hits) {
    const candidate = parseArtifactBlock(hit.content);
    if (!candidate) continue;
    const matched = confirmObjection(request, candidate);
    if (!matched) continue;
    const body = evidenceBody(request, candidate, matched);
    const comment = await add(ctx.actorId, ctx.ticketId, body, "evidence");
    return { objection: { candidateId: candidate.id, matched, body, commentId: comment.id } };
  }
  return { objection: null };
}

// Closes the reuse loop (requirement 3). Writes the human's choice as a `decision`
// comment AND mirrors it to a ticket-scoped note so the next preflight can find it.
export async function recordDecision(
  block: ArtifactBlock,
  choice: string,
  ctx: { ticketId: string; projectId: string; actorId: string; evidenceCommentId?: string },
  deps: { add?: typeof addComment; save?: typeof saveNote } = {},
): Promise<{ commentId: string; noteId: string }> {
  const add = deps.add ?? addComment;
  const save = deps.save ?? saveNote;
  const decided: ArtifactBlock = { ...block, action: choice };
  const sawLine = ctx.evidenceCommentId ? `\nEvidence seen: comment ${ctx.evidenceCommentId}.` : "";
  const body = `Chose: ${choice} ${block.artifact} ${block.id}.${sawLine}\n\n${formatArtifactBlock(decided)}`;
  const comment = await add(ctx.actorId, ctx.ticketId, body, "decision");
  const note = await save(ctx.actorId, { body, scope: "ticket", refId: ctx.ticketId, title: `decision ${block.artifact} ${block.id}` });
  return { commentId: comment.id, noteId: note.id };
}
