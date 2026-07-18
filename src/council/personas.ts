import { fenceUntrusted, UNTRUSTED_CLAUSE } from "../relay/prompts.js";

const PERSONA_ROLE: Record<"believer" | "investor" | "skeptic", string> = {
  believer: "optimist, best-case potential, cultural impact, enthusiastic",
  investor: "realist, economics, effort/cost, time-to-market, maintenance burden, skeptical of hype",
  skeptic: "roaster, actively destroy the idea, hidden flaws, market saturation, why users will not care, brutally honest"
};

export function composePersonaPrompt(persona: "believer" | "investor" | "skeptic", idea: string): string {
  return [
    `Role: ${PERSONA_ROLE[persona]}`,
    `Idea: ${fenceUntrusted("idea", idea)}`,
    `Answer in under 300 words as plain text.`,
    UNTRUSTED_CLAUSE
  ].filter(Boolean).join("\n\n");
}

export function composeChairmanPrompt(input: {
  idea: string;
  believer: string;
  investor: string;
  skeptic: string;
  qa?: { question: string; answer: string }[];
}): string {
  const parts = [
    `Idea: ${fenceUntrusted("idea", input.idea)}`,
    `Believer:\n${input.believer}`,
    `Investor:\n${input.investor}`,
    `Skeptic:\n${input.skeptic}`
  ];

  if (input.qa && input.qa.length > 0) {
    const qaBlock = input.qa.map(qa => `Q: ${qa.question}\nA: ${qa.answer}`).join("\n\n");
    parts.push(`Q&A:\n${qaBlock}`);
  }

  parts.push(UNTRUSTED_CLAUSE);

  parts.push(
    [
      `End with exactly this output contract at the end of the response, each on its own line:`,
      `RATING: <integer 0-10>/10`,
      `DECISION: GO or NO-GO or NEEDS-INFO`,
      `QUESTIONS:`,
      `- <question 1>`,
      `- <question 2>`,
      `TITLE: <one-line ticket title>`,
      `SPEC:`,
      `<full spec markdown>`
    ].join("\n")
  );

  return parts.filter(Boolean).join("\n\n");
}

export function parseChairman(output: string): {
  rating: number;
  decision: "GO" | "NO-GO" | "NEEDS-INFO";
  questions: string[];
  title: string;
  spec: string;
} {
  const ratingMatches = [...output.matchAll(/^\s*RATING:\s*(\d+)\/10\b/gim)];
  const lastRating = ratingMatches.at(-1);
  const rating = lastRating ? Math.min(10, Math.max(0, parseInt(lastRating[1], 10))) : 0;

  const decisionMatches = [...output.matchAll(/^\s*DECISION:\s*(GO|NO-GO|NEEDS-INFO)\b/gim)];
  const lastDecisionMatch = decisionMatches.at(-1);
  const decision = lastDecisionMatch ? (lastDecisionMatch[1] as "GO" | "NO-GO" | "NEEDS-INFO") : "NEEDS-INFO";

  const questionsMatches = [...output.matchAll(/^\s*QUESTIONS:\s*$/gim)];
  const lastQuestionsMatch = questionsMatches.at(-1);
  const questions: string[] = [];
  if (lastQuestionsMatch && lastQuestionsMatch.index !== undefined) {
    const afterQuestions = output.substring(lastQuestionsMatch.index + lastQuestionsMatch[0].length);
    const lines = afterQuestions.split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const qMatch = lines[i].match(/^-\s+(.+)/);
      if (qMatch) {
        questions.push(qMatch[1].trim());
        if (questions.length >= 5) break;
      } else {
        break;
      }
    }
  }

  const specMatches = [...output.matchAll(/^\s*SPEC:\s*$/gim)];
  const lastSpecMatch = specMatches.at(-1);
  let spec = "";
  if (lastSpecMatch && lastSpecMatch.index !== undefined) {
    spec = output.substring(lastSpecMatch.index + lastSpecMatch[0].length).replace(/^\r?\n/, '');
  }

  const titleMatches = [...output.matchAll(/^\s*TITLE:\s*(.+)$/gim)];
  const lastTitleMatch = titleMatches.at(-1);
  let title = "Untitled council ticket";
  if (lastTitleMatch) {
    title = lastTitleMatch[1].trim();
  } else if (spec) {
    const specLines = spec.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (specLines.length > 0) {
      title = specLines[0].substring(0, 80);
    }
  }

  return { rating, decision, questions, title, spec };
}
