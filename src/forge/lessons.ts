import { saveNote, updateNote, listNotes } from "../services/notes.js";
import { redactSecrets } from "./redact.js";
import { StaleVersionError } from "../services/errors.js";

const LESSONS_TITLE = "prompt-lessons";
const PROPOSALS_TITLE = "prompt-lessons-proposals";
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

// Fixed vocabulary of mechanically-executable checks the analyzer may propose.
// A proposal outside this set is a code-execution hole (checks eventually run as
// shell), so parseProposal coerces any unknown kind to a decline - it never returns
// an unrecognised kind. Phase 1 executes nothing; proposals are stored as text only.
export type Proposal =
  | { decision: "propose"; kind: "boot-sidecar" }
  | { decision: "propose"; kind: "npm-script"; script: string }
  | { decision: "propose"; kind: "grep-diff"; pattern: string }
  | { decision: "decline"; reason: string };

export function parseProposal(output: string): Proposal | null {
  const marker = "PROPOSAL:";
  const markerIdx = output.lastIndexOf(marker);
  if (markerIdx === -1) return null;

  const rest = output.slice(markerIdx + marker.length);
  const startIdx = rest.indexOf("{");
  if (startIdx === -1) return null;

  let endIdx = -1;
  let braceCount = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startIdx; i < rest.length; i++) {
    const char = rest[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === '{') {
        braceCount++;
      } else if (char === '}') {
        braceCount--;
        if (braceCount === 0) {
          endIdx = i;
          break;
        }
      }
    }
  }

  if (endIdx === -1) return null;
  const jsonStr = rest.slice(startIdx, endIdx + 1);

  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  if (parsed.decision === "decline") {
    const reason = typeof parsed.reason === "string" && parsed.reason.length > 0 ? parsed.reason : "no reason given";
    return { decision: "decline", reason };
  }
  if (parsed.decision === "propose") {
    if (parsed.kind === "boot-sidecar") return { decision: "propose", kind: "boot-sidecar" };
    if (parsed.kind === "npm-script" && typeof parsed.script === "string" && parsed.script.length > 0)
      return { decision: "propose", kind: "npm-script", script: parsed.script };
    if (parsed.kind === "grep-diff" && typeof parsed.pattern === "string" && parsed.pattern.length > 0)
      return { decision: "propose", kind: "grep-diff", pattern: parsed.pattern };
    // out-of-vocabulary or missing params -> forced decline, never an escape hatch.
    return { decision: "decline", reason: `out-of-vocabulary proposal: ${String(parsed.kind)}` };
  }
  return null;
}

export function formatProposal(p: Proposal): string {
  if (p.decision === "decline") return `DECLINE: ${p.reason}`;
  if (p.kind === "boot-sidecar") return `PROPOSE check: boot-sidecar`;
  if (p.kind === "npm-script") return `PROPOSE check: npm-script ${p.script}`;
  return `PROPOSE check: grep-diff /${p.pattern}/`;
}

export function composeAnalyzerPrompt(input: { output: string; outcome: string }): string {
  return [
    `You review a finished AI dev-pipeline run and decide whether its failure can be caught mechanically by a future automated check. Characterise what went wrong from the narrated output and outcome.`,
    `You may ONLY propose a check from this fixed vocabulary (never free-form shell):`,
    `- boot-sidecar: build the esbuild sidecar payload and boot it (catches bundle-only breakage that dev mode hides).`,
    `- npm-script: run one npm script that already exists in the sandbox package.json. Params: {"script":"<name>"}.`,
    `- grep-diff: grep the run's diff for a regex. Params: {"pattern":"<regex>"}.`,
    `If the failure is not mechanically detectable by one of those, or would need anything outside this vocabulary, DECLINE with a one-line reason. Declining is the correct answer for non-mechanisable failures (a missing regression guard, a mis-named test); do not force a check.`,
    `Propose at most one check.`,
    `Run output:\n${input.output}`,
    `Outcome: ${input.outcome}`,
    `Respond with a line "PROPOSAL:" followed by a single JSON object: {"decision":"propose","kind":"boot-sidecar"} or {"decision":"propose","kind":"npm-script","script":"..."} or {"decision":"propose","kind":"grep-diff","pattern":"..."} or {"decision":"decline","reason":"..."}.`,
  ].join("\n\n");
}
