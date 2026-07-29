import { saveNote, updateNote, listNotes } from "../services/notes.js";
import { redactSecrets } from "./redact.js";
import { StaleVersionError } from "../services/errors.js";
import { getSetting, setSetting } from "../services/settings.js";

const LESSONS_TITLE = "prompt-lessons";
const LESSONS_CAP = 1500;
const K = 6;
const LESSON_LINES_CAP = 12;
const MAX_OPS = 3;
const REJECTED_CAP = 10;
const STATE_KEY = "prompts.selfImprove.state";

export type Op = { op: "add" | "delete" | "replace"; target?: string; text?: string };
export type Outcome = "pass" | "fail";
export interface EvoState {
  version: number;
  baseline: { rate: number; window: Outcome[] };
  candidate: { version: number; parentDoc: string; ops: Op[]; window: Outcome[] } | null;
  rejected: Op[];
}

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

export function recordOutcome(state: EvoState, pass: boolean): EvoState {
  const o: Outcome = pass ? "pass" : "fail";
  if (state.candidate) {
    state.candidate.window.push(o);
    if (state.candidate.window.length > K) {
      state.candidate.window = state.candidate.window.slice(-K);
    }
  } else {
    state.baseline.window.push(o);
    if (state.baseline.window.length > K) {
      state.baseline.window = state.baseline.window.slice(-K);
    }
    const passCount = state.baseline.window.filter(x => x === "pass").length;
    if (state.baseline.window.length > 0) {
      state.baseline.rate = passCount / state.baseline.window.length;
    }
  }
  return state;
}

export function settleCandidate(state: EvoState): { state: EvoState; action: "promote"|"revert"|"none"; revertDoc?: string } {
  if (!state.candidate || state.candidate.window.length < K) {
    return { state, action: "none" };
  }
  
  const passCount = state.candidate.window.filter(x => x === "pass").length;
  const candRate = passCount / K;
  
  if (candRate < state.baseline.rate) {
    const revertDoc = state.candidate.parentDoc;
    state.rejected = pushRejected(state.rejected, state.candidate.ops);
    state.candidate = null;
    return { state, action: "revert", revertDoc };
  } else {
    state.baseline = { rate: candRate, window: [] };
    state.version = state.candidate.version;
    state.candidate = null;
    return { state, action: "promote" };
  }
}

export function pushRejected(buf: Op[], ops: Op[]): Op[] {
  const next = [...buf, ...ops];
  return next.slice(-REJECTED_CAP);
}

export function composeAnalyzerPrompt(input: { output: string; outcome: string; current: string; rejected: Op[] }): string {
  const parts = [
    `You maintain the prompt-lessons document for an AI dev pipeline. Study this run's narrated output and outcome. If the worker or planner misunderstood an instruction, identify the wording that failed and the wording that would have worked.`,
    `Max 12 lessons, each one line, imperative, concrete. Return at most 3 edit operations as a JSON array; state the op schema ({op:"add"|"delete"|"replace", target?, text?}); target must be an exact existing line.`,
    `Never contradict these hard rules: workers write files only, relative paths only, no git commits, REPORT:/VERDICT: contracts.`,
    `Run output:\n${input.output}`,
    `Outcome: ${input.outcome}`,
    `Current lessons document:\n${input.current || "(empty)"}`,
  ];
  
  if (input.rejected.length > 0) {
    parts.push(`These edits were tried and made things worse; do not re-propose them:\n${JSON.stringify(input.rejected)}`);
  }
  
  parts.push(`Respond with a line "OPS:" followed by a JSON array of operations.`);
  
  return parts.join("\n\n");
}

export async function loadEvoState(): Promise<EvoState> {
  const raw = await getSetting(STATE_KEY);
  if (!raw) return { version: 0, baseline: { rate: 0, window: [] }, candidate: null, rejected: [] };
  try {
    return JSON.parse(raw);
  } catch {
    return { version: 0, baseline: { rate: 0, window: [] }, candidate: null, rejected: [] };
  }
}

export async function saveEvoState(state: EvoState): Promise<void> {
  await setSetting(STATE_KEY, JSON.stringify(state));
}
