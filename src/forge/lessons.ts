import { saveNote, updateNote, listNotes } from "../services/notes.js";
import { redactSecrets } from "./redact.js";
import { StaleVersionError } from "../services/errors.js";

const LESSONS_TITLE = "prompt-lessons";
const LESSONS_CAP = 1500;

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

export function lessonsClause(lessons: string): string {
  if (!lessons) return "";
  return `\n\nPrompting lessons learned (follow these):\n${lessons}`;
}
