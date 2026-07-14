type TicketLike = { title: string; body?: string | null };
type KnowledgeItem = { content: string; citation?: string; sourceRef?: string };

function formatKnowledge(knowledge: KnowledgeItem[]): string {
  if (!knowledge.length) return "(no relevant knowledge found)";
  return knowledge
    .map((k, i) => `[${i + 1}] ${k.citation ?? k.sourceRef ?? "unknown"}\n${k.content}`)
    .join("\n\n");
}

export function composePlanPrompt(
  { ticket, knowledge }: { ticket: TicketLike; knowledge: KnowledgeItem[] },
): string {
  return [
    `Ticket: ${ticket.title}`,
    ticket.body ? ticket.body : "",
    `\nRelevant knowledge:\n${formatKnowledge(knowledge)}`,
    `\nWrite an implementation plan for this ticket, with concrete acceptance criteria.`,
  ].filter(Boolean).join("\n");
}

export function composeWorkPrompt(
  { ticket, plan, knowledge, workdir }: {
    ticket: TicketLike; plan: string; knowledge: KnowledgeItem[]; workdir: string;
  },
): string {
  return [
    `Ticket: ${ticket.title}`,
    ticket.body ? ticket.body : "",
    `\nPlan:\n${plan}`,
    `\nRelevant knowledge:\n${formatKnowledge(knowledge)}`,
    `\nImplement this plan. Work in ${workdir}.`,
    `\nEnd your output with a section starting REPORT:`,
  ].filter(Boolean).join("\n");
}

export function composeReviewPrompt(
  { ticket, plan, report, diff }: {
    ticket: TicketLike; plan: string; report: string; diff: string;
  },
): string {
  return [
    `Ticket: ${ticket.title}`,
    `\nPlan:\n${plan}`,
    `\nWorker report:\n${report}`,
    `\nDiff:\n${diff}`,
    `\nReview whether the diff satisfies the plan's acceptance criteria.`,
    `End with exactly one line VERDICT: PASS or VERDICT: FAIL followed by findings if FAIL.`,
  ].join("\n");
}

// Fail-closed: no VERDICT line, or anything other than PASS, means the ticket
// does not close. Take the LAST line-anchored verdict — reviewers narrate
// ("I would pass this, but...") before their final line, and a first-match
// scan turned that prose into a fail-open close.
export function parseVerdict(output: string): { pass: boolean; raw: string } {
  const matches = [...output.matchAll(/^\s*VERDICT:\s*(PASS|FAIL)\b/gim)];
  const last = matches.at(-1);
  return { pass: last?.[1].toUpperCase() === "PASS", raw: output };
}
