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

export type HarvestContext = {
  ticketTitle: string;
  status: string;
  verdict?: string;
  reviewFindings?: string;
  checkOutput?: string;
};

export async function harvestLessons(actorId: string, ctx: HarvestContext): Promise<string | undefined> {
  if (!ctx.reviewFindings && !ctx.checkOutput) return undefined;

  const endpoint = process.env.VIBEOPS_LESSONS_ENDPOINT || "http://127.0.0.1:8086/v1/completions";
  const prompt = [
    "Task: Fix unit tests for auth middleware",
    "Findings: Critical: verifyToken not exported",
    "Rule: Always export helper functions required by unit tests.",
    "",
    "Task: Support stream rollback in chat",
    "Findings: Critical: missing message rollback on error",
    "Rule: Always restore previous state on streaming failures.",
    "",
    `Task: ${ctx.ticketTitle}`,
    ctx.reviewFindings ? `Findings: ${ctx.reviewFindings.slice(0, 300).replace(/\r?\n/g, " ")}` : "",
    ctx.checkOutput ? `Failing checks: ${ctx.checkOutput.slice(0, 200).replace(/\r?\n/g, " ")}` : "",
    "Rule:",
  ].filter(Boolean).join("\n");

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        max_tokens: 30,
        temperature: 0.1,
        stop: ["\n", "Task:", "Findings:"],
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return undefined;
    const data = await res.json() as { choices?: { text?: string }[] };
    const text = (data.choices?.[0]?.text || "").trim();
    if (!text || text.length < 5) return undefined;

    const cleanLesson = text.replace(/^[-*•\s]+/, "").trim();
    const existing = await getLessons();
    if (existing.includes(cleanLesson)) return cleanLesson;

    const updated = existing ? `${existing}\n- ${cleanLesson}` : `- ${cleanLesson}`;
    await setLessons(actorId, updated);
    return cleanLesson;
  } catch {
    return undefined;
  }
}

