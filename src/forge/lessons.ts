import { saveNote, updateNote, listNotes } from "../services/notes.js";
import { redactSecrets } from "./redact.js";
import { StaleVersionError } from "../services/errors.js";

const LESSONS_TITLE = "prompt-lessons";
const PROPOSALS_TITLE = "prompt-lessons-proposals";
const LESSONS_CAP = 1500;
const LESSON_LINES_CAP = 12;
const MAX_OPS = 3;

export type Op = { op: "add" | "delete" | "replace"; target?: string; text?: string };

async function findNote(title: string) {
  const rows = await listNotes({ scope: "global" });
  return rows.find((n) => n.title === title);
}

export async function getLessons(): Promise<string> {
  const note = await findNote(LESSONS_TITLE);
  return note?.body ?? "";
}

// Redact BEFORE capping: capping first can slice a secret in half at the 1500
// boundary, leaving a partial credential that no longer matches redactSecrets'
// patterns and slips through unredacted.
async function writeNote(actorId: string, title: string, text: string): Promise<void> {
  const capped = redactSecrets(text).slice(0, LESSONS_CAP);
  try {
    const existing = await findNote(title);
    if (!existing) {
      await saveNote(actorId, { body: capped, scope: "global", title });
      return;
    }
    try {
      await updateNote(actorId, existing.id, existing.version, { body: capped });
    } catch (e) {
      if (!(e instanceof StaleVersionError)) throw e;
      const fresh = await findNote(title);
      if (!fresh) {
        await saveNote(actorId, { body: capped, scope: "global", title });
        return;
      }
      await updateNote(actorId, fresh.id, fresh.version, { body: capped });
    }
  } catch (e) {
    console.warn(`forge: failed to update ${title} note:`, (e as Error).message);
  }
}

export async function setLessons(actorId: string, text: string): Promise<void> {
  await writeNote(actorId, LESSONS_TITLE, text);
}

// Advisory-only: the analyzer records its proposed lessons document here, in a
// note SEPARATE from the live prompt-lessons note. A human reviews it and, if
// they agree, copies it into prompt-lessons. No automated path writes the live note.
export async function recordProposal(actorId: string, text: string): Promise<void> {
  await writeNote(actorId, PROPOSALS_TITLE, text);
}

export function lessonsClause(lessons: string): string {
  if (!lessons) return "";
  return `\n\nPrompting lessons learned (follow these):\n${lessons}`;
}

export function parseOps(output: string): Op[] | null {
  const matches = [...output.matchAll(/^\s*OPS:\s*$/gim)];
  const last = matches.at(-1);
  if (!last || last.index === undefined) return null;
  const rest = output.slice(last.index + last[0].length).trim();
  
  let parsed: any;
  try {
    parsed = JSON.parse(rest);
  } catch {
    return null;
  }
  
  if (!Array.isArray(parsed)) return null;
  
  const valid = parsed.filter(item => {
    if (!item || typeof item !== "object") return false;
    if (item.op === "add" && typeof item.text === "string" && item.text.length > 0) return true;
    if (item.op === "delete" && typeof item.target === "string" && item.target.length > 0) return true;
    if (item.op === "replace" && typeof item.target === "string" && item.target.length > 0 && typeof item.text === "string" && item.text.length > 0) return true;
    return false;
  }) as Op[];
  
  return valid.slice(0, MAX_OPS);
}

export function applyOps(doc: string, ops: Op[]): { doc: string; applied: Op[]; rejected: Op[] } {
  const lines = doc.split("\n").filter(l => l.trim() !== "");
  const applied: Op[] = [];
  const rejected: Op[] = [];
  
  const deleteReplace = ops.filter(o => o.op === "delete" || o.op === "replace");
  const adds = ops.filter(o => o.op === "add");
  
  for (const op of deleteReplace) {
    const idx = lines.indexOf(op.target!);
    if (idx < 0) {
      rejected.push(op);
    } else {
      if (op.op === "delete") {
        lines.splice(idx, 1);
      } else {
        lines[idx] = redactSecrets(op.text!);
      }
      applied.push(op);
    }
  }
  
  for (const op of adds) {
    if (lines.length >= LESSON_LINES_CAP) {
      rejected.push(op);
    } else {
      lines.push(redactSecrets(op.text!));
      applied.push(op);
    }
  }
  
  return { doc: lines.join("\n"), applied, rejected };
}

export function composeAnalyzerPrompt(input: { output: string; outcome: string; current: string }): string {
  return [
    `You maintain the prompt-lessons document for an AI dev pipeline. Study this run's narrated output and outcome. If the worker or planner misunderstood an instruction, identify the wording that failed and the wording that would have worked.`,
    `Max 12 lessons, each one line, imperative, concrete. Return at most 3 edit operations as a JSON array; state the op schema ({op:"add"|"delete"|"replace", target?, text?}); target must be an exact existing line.`,
    `Never contradict these hard rules: workers write files only, relative paths only, no git commits, REPORT:/VERDICT: contracts.`,
    `Run output:\n${input.output}`,
    `Outcome: ${input.outcome}`,
    `Current lessons document:\n${input.current || "(empty)"}`,
    `Respond with a line "OPS:" followed by a JSON array of operations.`,
  ].join("\n\n");
}
