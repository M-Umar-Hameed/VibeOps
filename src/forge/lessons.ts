import { saveNote, updateNote, listNotes } from "../services/notes.js";
import { redactSecrets } from "./redact.js";
import { StaleVersionError } from "../services/errors.js";

const LESSONS_TITLE = "prompt-lessons";
const LESSONS_CAP = 1500;

async function findLessonsNote() {
  const rows = await listNotes({ scope: "global" });
  return rows.find((n) => n.title === LESSONS_TITLE);
}

export async function getLessons(): Promise<string> {
  const note = await findLessonsNote();
  return note?.body ?? "";
}

// Redact BEFORE capping: capping first can slice a secret in half at the 1500
// boundary, leaving a partial credential that no longer matches redactSecrets'
// patterns and slips through unredacted.
export async function setLessons(actorId: string, text: string): Promise<void> {
  const capped = redactSecrets(text).slice(0, LESSONS_CAP);
  try {
    const existing = await findLessonsNote();
    if (!existing) {
      await saveNote(actorId, { body: capped, scope: "global", title: LESSONS_TITLE });
      return;
    }
    try {
      await updateNote(actorId, existing.id, existing.version, { body: capped });
    } catch (e) {
      if (!(e instanceof StaleVersionError)) throw e;
      const fresh = await findLessonsNote();
      if (!fresh) {
        await saveNote(actorId, { body: capped, scope: "global", title: LESSONS_TITLE });
        return;
      }
      await updateNote(actorId, fresh.id, fresh.version, { body: capped });
    }
  } catch (e) {
    console.warn("forge: failed to update prompt-lessons note:", (e as Error).message);
  }
}

export function lessonsClause(lessons: string): string {
  if (!lessons) return "";
  return `\n\nPrompting lessons learned (follow these):\n${lessons}`;
}

export function composeAnalyzerPrompt(input: { output: string; outcome: string; current: string }): string {
  return [
    `You maintain the prompt-lessons document for an AI dev pipeline. Study this run's narrated output and outcome. If the worker or planner misunderstood an instruction, identify the wording that failed and the wording that would have worked.`,
    `Rewrite the COMPLETE lessons document: merge, generalize, and drop stale entries. Max 12 lessons, each one line, imperative, concrete.`,
    `Never contradict these hard rules: workers write files only, relative paths only, no git commits, REPORT:/VERDICT: contracts.`,
    `Run output:\n${input.output}`,
    `Outcome: ${input.outcome}`,
    `Current lessons document:\n${input.current || "(empty)"}`,
    `End with a line "LESSONS:" followed by the complete rewritten document.`,
  ].join("\n\n");
}

// Fail-closed like parseVerdict: last line-anchored LESSONS: wins, everything
// after it (trimmed) is the document. No line-anchored match -> null (no-op).
export function parseLessons(output: string): string | null {
  const matches = [...output.matchAll(/^\s*LESSONS:\s*$/gim)];
  const last = matches.at(-1);
  if (!last || last.index === undefined) return null;
  const rest = output.slice(last.index + last[0].length).replace(/^\r?\n/, "").trim();
  return rest.length ? rest : null;
}
