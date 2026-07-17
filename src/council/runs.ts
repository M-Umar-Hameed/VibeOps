import { randomUUID } from "node:crypto";
import type { RelayConfig } from "../relay/config.js";
import { resolveCmd } from "../relay/config.js";
import { pickAgents } from "../forge/router.js";
import { runAgent } from "../relay/invoke.js";
import { composeChairmanPrompt, composePersonaPrompt, parseChairman } from "./personas.js";
import { redactSecrets } from "../forge/redact.js";
import { ConflictError, NotFoundError } from "../services/errors.js";
import { createTicket } from "../services/tickets.js";

type Session = {
  id: string;
  prompt: string;
  projectId?: string;
  status: "running" | "awaiting-answers" | "decided" | "consumed" | "failed";
  round: number;
  output: string;
  believer?: string;
  investor?: string;
  skeptic?: string;
  qa?: { question: string; answer: string }[];
  verdict?: ReturnType<typeof parseChairman>;
  startedAt: string;
  finishedAt?: string;
};

const MAX_ACTIVE = 3;
const KEEP_FINISHED = 20;
const OUTPUT_CAP = 400_000;

const sessions = new Map<string, Session>();

function trim(): void {
  const finished = [...sessions.values()].filter((s) => s.status !== "running" && s.status !== "awaiting-answers")
    .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
  for (const s of finished.slice(KEEP_FINISHED)) sessions.delete(s.id);
}

function activeCount(): number {
  return [...sessions.values()].filter((s) => s.status === "running" || s.status === "awaiting-answers").length;
}

function append(session: Session, text: string): void {
  if (session.output.length < OUTPUT_CAP) session.output += redactSecrets(text);
}

export async function startCouncil(
  actorId: string,
  config: RelayConfig,
  opts: { prompt: string; projectId?: string }
): Promise<{ councilId: string }> {
  if (!opts.prompt || opts.prompt.length < 10 || opts.prompt.length > 10000) {
    throw new Error("prompt must be between 10 and 10000 characters");
  }
  if (activeCount() >= MAX_ACTIVE) {
    throw new ConflictError("too many active council sessions");
  }

  const id = randomUUID();
  const session: Session = {
    id,
    prompt: opts.prompt,
    projectId: opts.projectId,
    status: "running",
    round: 1,
    output: "",
    startedAt: new Date().toISOString(),
  };
  sessions.set(id, session);
  trim();

  runCouncilPipeline(session, config).catch((e) => {
    append(session, `\ncouncil error: ${(e as Error).message}\n`);
    session.status = "failed";
    session.finishedAt = new Date().toISOString();
  });

  return { councilId: id };
}

async function runCouncilPipeline(session: Session, config: RelayConfig): Promise<void> {
  const personasPick = pickAgents(config, "cheapest-first").plan;
  const personaAgent = { ...config.agents[personasPick.agent] };
  personaAgent.cmd = resolveCmd(personaAgent, personasPick.model);

  const workdir = config.workdir;

  const runPersona = async (role: "believer" | "investor" | "skeptic") => {
    const prompt = composePersonaPrompt(role, session.prompt);
    append(session, `\n=== COUNCIL ${role} ===\n`);
    const res = await runAgent(personaAgent, prompt, workdir, (chunk) => append(session, chunk));
    if (!res.ok) throw new Error(`${role} failed: ${res.output}`);
    session[role] = res.output;
  };

  await Promise.all([
    runPersona("believer"),
    runPersona("investor"),
    runPersona("skeptic"),
  ]);

  await runChairman(session, config);
}

async function runChairman(session: Session, config: RelayConfig): Promise<void> {
  const chairmanPick = pickAgents(config, "quality-first").plan;
  const chairmanAgent = { ...config.agents[chairmanPick.agent] };
  chairmanAgent.cmd = resolveCmd(chairmanAgent, chairmanPick.model);

  const prompt = composeChairmanPrompt({
    idea: session.prompt,
    believer: session.believer!,
    investor: session.investor!,
    skeptic: session.skeptic!,
    qa: session.qa,
  });

  append(session, `\n=== COUNCIL chairman ===\n`);
  const res = await runAgent(chairmanAgent, prompt, config.workdir, (chunk) => append(session, chunk));
  if (!res.ok) throw new Error(`chairman failed: ${res.output}`);

  session.verdict = parseChairman(res.output);
  if (session.round >= 3 || session.verdict.questions.length === 0) {
    session.status = "decided";
    session.finishedAt = new Date().toISOString();
  } else {
    session.status = "awaiting-answers";
  }
}

export async function submitAnswers(councilId: string, config: RelayConfig, answers: string[]): Promise<void> {
  const session = sessions.get(councilId);
  if (!session) throw new NotFoundError("council not found");
  if (session.status !== "awaiting-answers") throw new ConflictError("council not awaiting answers");

  const questions = session.verdict?.questions || [];
  const qa = questions.map((q, i) => ({ question: q, answer: answers[i] || "" }));
  session.qa = [...(session.qa || []), ...qa];
  session.round++;
  session.status = "running";

  runChairman(session, config).catch((e) => {
    append(session, `\ncouncil error: ${(e as Error).message}\n`);
    session.status = "failed";
    session.finishedAt = new Date().toISOString();
  });
}

export async function createTicketFromCouncil(
  actorId: string,
  councilId: string,
  projectId: string,
  force = false
): Promise<any> {
  const session = sessions.get(councilId);
  if (!session) throw new NotFoundError("council not found");
  
  if (session.status !== "decided" && !(session.status === "awaiting-answers" && force)) {
    throw new ConflictError("council not decided or awaiting answers");
  }
  
  if (session.verdict?.decision !== "GO" && !force) {
    throw new ConflictError("verdict is not GO and force is not set");
  }

  const spec = session.verdict?.spec || "";
  const rating = session.verdict?.rating || 0;
  const decision = session.verdict?.decision || "NEEDS-INFO";
  const title = session.verdict?.title || "Untitled";

  const formatPersona = (text?: string) => text ? text.split("\n")[0].trim().substring(0, 100) : "N/A";
  const body = `${spec}\n\n---\nCouncil verdict: ${rating}/10 ${decision} (round ${session.round})\n- Believer: ${formatPersona(session.believer)}\n- Investor: ${formatPersona(session.investor)}\n- Skeptic: ${formatPersona(session.skeptic)}`;  
  const ticket = await createTicket(actorId, { projectId, title, body, status: "open" });
  session.status = "consumed";
  session.finishedAt = new Date().toISOString();
  return ticket;
}

export function getCouncil(id: string) {
  const session = sessions.get(id);
  if (!session) throw new NotFoundError("council not found");
  const { output, verdict, ...rest } = session;
  return { ...rest, ...(verdict || {}) };
}

export function getCouncilOutput(id: string, after: number) {
  const session = sessions.get(id);
  if (!session) return undefined;
  const from = Math.max(0, Math.min(after, session.output.length));
  return { chunk: session.output.slice(from), next: session.output.length, status: session.status };
}
